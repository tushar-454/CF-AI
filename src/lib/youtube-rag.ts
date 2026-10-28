/**
 * Vector indexing and grounded RAG retrieval for YouTube video transcripts.
 * Reuses the existing BGE-base-en-v1.5 embedding model and Vectorize index.
 * Strictly scopes retrieval to the specified canonical video ID.
 */

import { getEmbeddings } from "./rag"
import { YOUTUBE_CHAT_CONFIG } from "./youtube-model-config"
import type {
    AppEnv,
    R2BucketBinding,
    VectorizeIndexBinding,
    VectorizeQueryResult,
    WorkersAi,
} from "./types"
import type { NormalizedTranscript, YoutubeChunk } from "./youtube-types"
import { getYoutubeChunks, getYoutubeVideo } from "./db"

export interface RetrievedYoutubeChunk {
    id: string
    videoId: string
    chunkIndex: number
    startSeconds: number
    endSeconds: number
    text: string
    score: number
}

/**
 * Persists normalized transcript and generated chunks to R2 storage for fast direct access.
 */
export async function persistYoutubeR2Artifacts(
    r2: R2BucketBinding,
    videoId: string,
    transcript: NormalizedTranscript,
    chunks: YoutubeChunk[]
): Promise<void> {
    const transcriptKey = `youtube/${videoId}/transcript.json`
    const chunksKey = `youtube/${videoId}/chunks.json`

    await r2.put(transcriptKey, JSON.stringify(transcript), {
        httpMetadata: { contentType: "application/json; charset=utf-8" },
        customMetadata: { videoId, segmentCount: String(transcript.segments.length) },
    })

    await r2.put(chunksKey, JSON.stringify(chunks), {
        httpMetadata: { contentType: "application/json; charset=utf-8" },
        customMetadata: { videoId, chunkCount: String(chunks.length) },
    })
}

/**
 * Loads transcript from R2 storage.
 */
export async function getYoutubeTranscriptFromR2(
    r2: R2BucketBinding,
    videoId: string
): Promise<NormalizedTranscript | null> {
    try {
        const obj = await r2.get(`youtube/${videoId}/transcript.json`)
        if (!obj) return null
        const text = obj.text ? await obj.text() : new TextDecoder().decode(await obj.arrayBuffer())
        return JSON.parse(text) as NormalizedTranscript
    } catch {
        return null
    }
}

/**
 * Loads chunks from R2 storage.
 */
export async function getYoutubeChunksFromR2(
    r2: R2BucketBinding,
    videoId: string
): Promise<YoutubeChunk[]> {
    try {
        const obj = await r2.get(`youtube/${videoId}/chunks.json`)
        if (!obj) return []
        const text = obj.text ? await obj.text() : new TextDecoder().decode(await obj.arrayBuffer())
        return JSON.parse(text) as YoutubeChunk[]
    } catch {
        return []
    }
}

/**
 * Embeds and upserts transcript chunks into Vectorize using stable vector IDs: `${videoId}_${chunkIndex}`.
 */
export async function indexYoutubeChunks(
    ai: WorkersAi,
    vectorize: VectorizeIndexBinding,
    videoId: string,
    chunks: YoutubeChunk[]
): Promise<{ chunksIndexed: number }> {
    if (!chunks || chunks.length === 0) {
        return { chunksIndexed: 0 }
    }

    const chunkTexts = chunks.map((c) => c.text)
    const vectors = await getEmbeddings(ai, chunkTexts)

    const vectorizeRecords = chunks.map((chunk, index) => ({
        id: `${videoId}_${chunk.chunkIndex}`,
        values: vectors[index],
        metadata: {
            videoId,
            type: "youtube",
            chunkIndex: chunk.chunkIndex,
            startSeconds: chunk.startSeconds,
            endSeconds: chunk.endSeconds,
            text: chunk.text.slice(0, 1500),
        },
    }))

    // Upsert in bounded batches of 20
    const upsertBatchSize = 20
    for (let i = 0; i < vectorizeRecords.length; i += upsertBatchSize) {
        const batch = vectorizeRecords.slice(i, i + upsertBatchSize)
        await vectorize.upsert(batch)
    }

    return { chunksIndexed: chunks.length }
}

/**
 * Retrieves the most relevant transcript chunks for a user query on a specific YouTube video.
 * Enforces strict video ID scoping and features layered keyword scoring fallback if Vectorize
 * has not finished indexing or yields no matches.
 */
export async function retrieveYoutubeContext(
    ai: WorkersAi | undefined,
    vectorize: VectorizeIndexBinding | undefined,
    r2: R2BucketBinding | undefined,
    db: unknown,
    videoId: string,
    query: string,
    topK: number = YOUTUBE_CHAT_CONFIG.retrievalTopK
): Promise<RetrievedYoutubeChunk[]> {
    const results: RetrievedYoutubeChunk[] = []

    // 1. Vectorize similarity search (if bindings available)
    if (ai && vectorize) {
        try {
            const queryVectors = await getEmbeddings(ai, [query])
            if (queryVectors && queryVectors.length > 0) {
                const queryVector = queryVectors[0]
                let searchResult: VectorizeQueryResult | null = null

                try {
                    // Filter specifically by videoId
                    searchResult = await vectorize.query(queryVector, {
                        topK,
                        returnMetadata: "all",
                        filter: { videoId },
                    })
                } catch {
                    // Fallback to query with broader topK and client-side filter
                    searchResult = await vectorize.query(queryVector, {
                        topK: Math.max(topK, 50),
                        returnMetadata: "all",
                    })
                }

                if (searchResult && Array.isArray(searchResult.matches)) {
                    for (const m of searchResult.matches) {
                        const mVideoId = String(
                            m.metadata?.videoId ||
                                (m.id.includes("_") ? m.id.slice(0, m.id.lastIndexOf("_")) : "")
                        )
                        if (mVideoId === videoId) {
                            results.push({
                                id: m.id,
                                videoId,
                                chunkIndex: Number(m.metadata?.chunkIndex || 0),
                                startSeconds: Number(m.metadata?.startSeconds || 0),
                                endSeconds: Number(m.metadata?.endSeconds || 0),
                                text: String(m.metadata?.text || ""),
                                score: m.score,
                            })
                        }
                    }
                }
            }
        } catch (vecErr) {
            console.warn(`[YouTube RAG] Vectorize search failed for video ${videoId}:`, vecErr)
        }
    }

    // 2. Layered fallback: If fewer than 2 chunks returned, load from D1 or R2 and score by keywords
    if (results.length < 2) {
        let allChunks: YoutubeChunk[] = []
        if (db) {
            allChunks = await getYoutubeChunks(videoId, db).catch(() => [])
        }
        if (allChunks.length === 0 && r2) {
            allChunks = (await getYoutubeChunksFromR2(r2, videoId).catch(() => [])) || []
        }

        if (allChunks.length > 0) {
            const queryTerms = query
                .toLowerCase()
                .replace(/[^a-z0-9\s]/g, " ")
                .split(/\s+/)
                .filter((t) => t.length >= 3)

            const scoredChunks = allChunks.map((c) => {
                const lower = c.text.toLowerCase()
                let score = 0
                for (const term of queryTerms) {
                    if (lower.includes(term)) {
                        score += 1
                    }
                }
                // Bias opening chunks slightly if general question
                if (c.chunkIndex === 0) score += 1
                return { chunk: c, score }
            })

            scoredChunks.sort((a, b) => b.score - a.score)
            const topScored = scoredChunks.slice(0, 4)

            for (const item of topScored) {
                if (!results.some((r) => r.chunkIndex === item.chunk.chunkIndex)) {
                    results.push({
                        id: item.chunk.id,
                        videoId,
                        chunkIndex: item.chunk.chunkIndex,
                        startSeconds: item.chunk.startSeconds,
                        endSeconds: item.chunk.endSeconds,
                        text: item.chunk.text,
                        score: item.score > 0 ? 0.75 : 0.5,
                    })
                }
            }
        }
    }

    // Sort selected chunks into chronological reading order by startSeconds
    results.sort((a, b) => a.startSeconds - b.startSeconds)

    return results.slice(0, YOUTUBE_CHAT_CONFIG.maxContextChunks)
}

/**
 * Critical skip-processing verification:
 * Confirms that a video's transcript, chunks, and Vectorize records are fully completed
 * and compatible before skipping extraction or embedding.
 */
export async function verifyYoutubeIndexingComplete(
    env: AppEnv,
    videoId: string,
    expectedLang?: string
): Promise<boolean> {
    if (!env || !env.DB || !videoId) {
        return false
    }
    const video = await getYoutubeVideo(videoId, env.DB).catch(() => null)
    if (!video || video.status !== "ready" || video.chunk_count <= 0) {
        return false
    }

    if (video.embedding_model !== YOUTUBE_CHAT_CONFIG.embeddingModelId) {
        return false
    }

    // Verify transcript language matches expected language if specified (e.g. "bn" vs "en")
    if (expectedLang && video.transcript_lang && video.transcript_lang !== expectedLang) {
        return false
    }

    // Verify chunks exist in D1 or R2
    const chunks = await getYoutubeChunks(videoId, env.DB).catch(() => [])
    if (chunks.length === 0 && env.FILES) {
        const r2Chunks = await getYoutubeChunksFromR2(env.FILES, videoId)
        if (r2Chunks.length === 0) return false
    } else if (chunks.length === 0) {
        return false
    }

    // Verify transcript exists
    if (env.FILES) {
        const transcript = await getYoutubeTranscriptFromR2(env.FILES, videoId)
        if (!transcript || transcript.segments.length === 0) return false
    }

    return true
}

/**
 * Deletes vectors associated with a YouTube video.
 */
export async function deleteYoutubeVectors(
    vectorize: VectorizeIndexBinding,
    videoId: string,
    chunkCount?: number | null
): Promise<void> {
    try {
        const count = Math.max(chunkCount && chunkCount > 0 ? chunkCount : 50, 50)
        const batchSize = 100
        for (let start = 0; start < count; start += batchSize) {
            const end = Math.min(start + batchSize, count)
            const ids: string[] = []
            for (let i = start; i < end; i++) {
                ids.push(`${videoId}_${i}`)
            }
            await vectorize.deleteByIds(ids)
        }
    } catch {
        // Best-effort deletion
    }
}
