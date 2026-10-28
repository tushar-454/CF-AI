/**
 * Linear execution pipeline for YouTube video transcription and indexing.
 * Used for direct execution fallback, background task processing, and test suites.
 */

import {
    createYoutubeVideo,
    failYoutubeVideo,
    getYoutubeChunks,
    getYoutubeVideo,
    saveYoutubeChunks,
    updateYoutubeVideoProgress,
} from "./db"
import { SupadataError } from "./supadata"
import { extractYouTubeTranscript } from "./youtube-extractor"
import type {
    AppEnv,
    DocumentProgressEvent,
    DocumentStage,
    DocumentStatus,
    VectorizeIndexBinding,
} from "./types"
import { chunkTranscriptSegments } from "./youtube-chunker"
import { YOUTUBE_CHAT_CONFIG } from "./youtube-model-config"
import {
    indexYoutubeChunks,
    persistYoutubeR2Artifacts,
    verifyYoutubeIndexingComplete,
} from "./youtube-rag"
import type { Transcript, TranscriptList } from "extract-youtube"
import type {
    YoutubeChunk,
    YoutubeProgressEvent,
    YoutubeVideoItem,
    YoutubeVideoStage,
    YoutubeVideoStatus,
} from "./youtube-types"
import { parseYouTubeUrl } from "./youtube-url"
import { detectYouTubeVideoLanguage } from "./youtube-metadata"

export interface YoutubeWorkflowParams {
    videoId: string
    url: string
    forceAiTranscription?: boolean
    title?: string
    transcriptApi?: {
        listTranscripts(videoId: string): Promise<TranscriptList | Iterable<Transcript>>
    }
}

export async function publishVideoProgress(
    env: AppEnv,
    event: YoutubeProgressEvent
): Promise<void> {
    try {
        if (!env.DOCUMENT_PROGRESS_DO) return
        const doId = env.DOCUMENT_PROGRESS_DO.idFromName(event.videoId)
        const stub = env.DOCUMENT_PROGRESS_DO.get(doId)

        const doEvent: DocumentProgressEvent = {
            documentId: event.videoId,
            status: (event.status === "ready"
                ? "ready"
                : event.status === "failed"
                  ? "failed"
                  : "processing") as DocumentStatus,
            stage: (event.stage === "ready"
                ? "ready"
                : event.stage === "failed"
                  ? "failed"
                  : event.stage) as DocumentStage,
            progress: event.progress,
            message: event.message,
            error: event.error,
            completedAt: event.completedAt,
            timestamp: event.timestamp,
            chunksIndexed: event.chunksIndexed,
            totalChunks: event.totalChunks,
            diagnostic: event.diagnostic,
        }

        if (typeof stub.reportProgress === "function") {
            await stub.reportProgress(doEvent)
        } else {
            await stub.fetch("https://internal/event", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(doEvent),
            })
        }
    } catch (err) {
        console.warn(`[Workflow] Failed to publish progress for video ${event.videoId}:`, err)
    }
}

/**
 * Direct execution pipeline for YouTube video transcription and indexing without Workflow step engine.
 */
export async function executeYoutubePipeline(
    env: AppEnv,
    params: YoutubeWorkflowParams
): Promise<{ success: boolean; awaitingConfirmation?: boolean }> {
    const { videoId, url, forceAiTranscription = false } = params
    let currentStage: YoutubeVideoStage = "validating"
    let currentProgress = 5

    const report = async (
        stage: YoutubeVideoStage,
        progress: number,
        message?: string,
        extras?: Partial<YoutubeProgressEvent>
    ) => {
        currentStage = stage
        currentProgress = progress
        const status: YoutubeVideoStatus =
            stage === "ready"
                ? "ready"
                : stage === "failed"
                  ? "failed"
                  : stage === "awaiting_confirmation"
                    ? "awaiting_confirmation"
                    : "validating"

        await updateYoutubeVideoProgress(
            videoId,
            {
                status,
                stage,
                progress,
                error_message: null,
            },
            env.DB
        )

        const event: YoutubeProgressEvent = {
            videoId,
            status,
            stage,
            progress,
            message,
            timestamp: Date.now(),
            ...extras,
        }
        await publishVideoProgress(env, event)
    }

    try {
        // Step 1: Validate URL and check cache completeness
        const parsed = parseYouTubeUrl(url)
        if (!parsed.isValid) {
            throw new Error(`Invalid YouTube URL: ${parsed.error}`)
        }
        if (parsed.videoId !== videoId) {
            throw new Error(`URL video ID mismatch: expected ${videoId}, parsed ${parsed.videoId}`)
        }

        await report("checking_cache", 10, "Checking existing video knowledge cache...")

        // Step 1.5: Detect authoritative video audio language and real title
        const detected = await detectYouTubeVideoLanguage(videoId).catch(() => null)
        const targetLang = detected?.baseLang || "en"
        const resolvedTitle = params.title || detected?.title || `YouTube Video (${videoId})`

        const isFullyIndexed = await verifyYoutubeIndexingComplete(env, videoId, targetLang)
        if (isFullyIndexed) {
            await report("ready", 100, "Reusing existing verified video knowledge index.")
            return { success: true }
        }

        const existing = await getYoutubeVideo(videoId, env.DB)
        if (!existing) {
            const now = Date.now()
            const newRecord: YoutubeVideoItem = {
                id: videoId,
                title: resolvedTitle,
                url: parsed.canonicalUrl,
                duration: 0,
                transcript_version: 1,
                status: "validating",
                stage: "validating",
                progress: 10,
                embedding_model: YOUTUBE_CHAT_CONFIG.embeddingModelId,
                chunk_count: 0,
                created_at: now,
                updated_at: now,
            }
            await createYoutubeVideo(newRecord, env.DB)
        } else if (detected?.title && existing.title.startsWith("YouTube Video (")) {
            await updateYoutubeVideoProgress(videoId, { title: detected.title }, env.DB)
        }

        // Step 2: Transcript retrieval (primary: extract-youtube, fallback: supadata native, confirmation: supadata AI)
        await report("extracting", 20, "Extracting captions from YouTube...")

        const extractionResult = await extractYouTubeTranscript(videoId, env, {
            lang: targetLang,
            forceAiTranscription,
            transcriptApi: params.transcriptApi,
        })

        if (extractionResult.needsConfirmation || !extractionResult.transcript) {
            await report(
                "awaiting_confirmation",
                25,
                extractionResult.message ||
                    "No native captions found. AI speech-to-text transcription is available with user confirmation.",
                {
                    needsConfirmation: true,
                    diagnostic: extractionResult.diagnostic,
                }
            )
            return { success: false, awaitingConfirmation: true }
        }

        if (extractionResult.diagnostic) {
            await report(
                "extracting",
                30,
                extractionResult.diagnostic.message,
                { diagnostic: extractionResult.diagnostic }
            )
        }

        const normalizedTranscript = extractionResult.transcript

        // Step 3: Chunking & artifact persistence
        await report("chunking", 50, "Generating semantic timestamped chunks...")

        const chunks = chunkTranscriptSegments(videoId, normalizedTranscript.segments)
        if (chunks.length === 0) {
            throw new Error("Transcript contained no readable text to index.")
        }

        await saveYoutubeChunks(videoId, chunks, env.DB)

        if (env.FILES) {
            await persistYoutubeR2Artifacts(env.FILES, videoId, normalizedTranscript, chunks)
        }

        await updateYoutubeVideoProgress(
            videoId,
            {
                duration: normalizedTranscript.duration,
                transcript_lang: normalizedTranscript.lang,
                transcript_source: normalizedTranscript.source,
                chunk_count: chunks.length,
            },
            env.DB
        )

        await report(
            "embedding",
            65,
            `Generated ${chunks.length} transcript chunks. Computing embeddings...`,
            { totalChunks: chunks.length }
        )

        // Step 4: Embedding generation and Vectorize upsert
        const ai = env.AI
        const vectorize = env.VECTORIZE as VectorizeIndexBinding | undefined

        let chunksIndexed = 0
        if (!ai || !vectorize) {
            console.warn(
                "[YouTube Pipeline] Vectorize or Workers AI binding missing. Stored chunks in D1/R2 for keyword RAG."
            )
        } else {
            await report("indexing", 80, `Indexing ${chunks.length} vectors into Vectorize...`, {
                totalChunks: chunks.length,
            })

            let chunksToIndex: YoutubeChunk[] = chunks
            if (!chunksToIndex || chunksToIndex.length === 0) {
                chunksToIndex = await getYoutubeChunks(videoId, env.DB)
            }

            const indexResult = await indexYoutubeChunks(ai, vectorize, videoId, chunksToIndex)
            chunksIndexed = indexResult.chunksIndexed

            await report(
                "indexing",
                95,
                `Indexed ${chunksIndexed} vector records. Finalizing video knowledge...`,
                { chunksIndexed, totalChunks: chunksToIndex.length }
            )
        }

        // Step 5: Mark ready & finalize
        const now = Date.now()
        await updateYoutubeVideoProgress(
            videoId,
            {
                status: "ready",
                stage: "ready",
                progress: 100,
                completed_at: now,
                error_message: null,
            },
            env.DB
        )

        await report("ready", 100, "Video is indexed and ready for grounded chat.", {
            completedAt: now,
            chunksIndexed: chunks.length,
            totalChunks: chunks.length,
        })

        return { success: true }
    } catch (err: unknown) {
        const errorMsg =
            err instanceof SupadataError
                ? err.message
                : err instanceof Error
                  ? err.message
                  : "Video processing failed."

        console.error(
            `[YouTube Pipeline Error] Video ${videoId} failed in stage ${currentStage}:`,
            err
        )

        await failYoutubeVideo(videoId, errorMsg, currentStage, env.DB).catch(() => {})

        const failEvent: YoutubeProgressEvent = {
            videoId,
            status: "failed",
            stage: "failed",
            progress: currentProgress,
            error: errorMsg,
            timestamp: Date.now(),
        }
        await publishVideoProgress(env, failEvent).catch(() => {})

        throw err
    }
}
