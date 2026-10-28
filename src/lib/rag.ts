import { env } from "cloudflare:workers"
import { EMBEDDING_MODEL_ID } from "./models"
import type {
    AppEnv,
    VectorizeIndexBinding,
    VectorizeMatch,
    VectorizeQueryResult,
    WorkersAi,
} from "./types"

export class VectorizeBindingError extends Error {
    constructor(
        message: string = "Vectorize binding (VECTORIZE) is missing or unconfigured. Please replace REPLACE_WITH_VECTORIZE_INDEX_NAME in cloudflare.config.ts."
    ) {
        super(message)
        this.name = "VectorizeBindingError"
    }
}

export function getVectorize(override?: unknown): VectorizeIndexBinding {
    const appEnv = env as unknown as AppEnv
    const index = (override as VectorizeIndexBinding) || appEnv.VECTORIZE
    if (!index || typeof index.query !== "function") {
        throw new VectorizeBindingError()
    }
    return index
}

/**
 * Split text into chunks (~800 characters, ~100 overlap), preferring natural paragraph/sentence breaks.
 */
export function chunkText(text: string, chunkSize: number = 800, overlap: number = 100): string[] {
    const clean = text.replace(/\r\n/g, "\n").trim()
    if (!clean) return []
    if (clean.length <= chunkSize) return [clean]

    const chunks: string[] = []
    let startIndex = 0

    while (startIndex < clean.length) {
        let endIndex = startIndex + chunkSize

        if (endIndex >= clean.length) {
            chunks.push(clean.slice(startIndex).trim())
            break
        }

        // Attempt to break at paragraph, line, or sentence boundary
        const slice = clean.slice(startIndex, endIndex)
        const lastParagraphBreak = slice.lastIndexOf("\n\n")
        const lastLineBreak = slice.lastIndexOf("\n")
        const lastSentenceBreak = Math.max(
            slice.lastIndexOf(". "),
            slice.lastIndexOf("? "),
            slice.lastIndexOf("! ")
        )

        let splitAt = -1
        if (lastParagraphBreak > chunkSize * 0.5) {
            splitAt = lastParagraphBreak + 2
        } else if (lastSentenceBreak > chunkSize * 0.5) {
            splitAt = lastSentenceBreak + 2
        } else if (lastLineBreak > chunkSize * 0.5) {
            splitAt = lastLineBreak + 1
        }

        if (splitAt !== -1) {
            endIndex = startIndex + splitAt
        }

        const chunk = clean.slice(startIndex, endIndex).trim()
        if (chunk) {
            chunks.push(chunk)
        }

        startIndex = Math.max(startIndex + 1, endIndex - overlap)
    }

    return chunks
}

/**
 * Embed an array of texts in batches using @cf/baai/bge-base-en-v1.5
 */
export async function getEmbeddings(ai: WorkersAi, texts: string[]): Promise<number[][]> {
    if (!ai || typeof ai.run !== "function") {
        throw new Error("Workers AI binding (AI) is missing or unavailable.")
    }
    if (texts.length === 0) return []

    const batchSize = 10
    const allVectors: number[][] = []

    for (let i = 0; i < texts.length; i += batchSize) {
        const batch = texts.slice(i, i + batchSize)
        const result = (await ai.run(EMBEDDING_MODEL_ID, { text: batch })) as {
            data?: number[][]
        } | null
        if (result && Array.isArray(result.data)) {
            allVectors.push(...result.data)
        } else {
            throw new Error(`Embedding model returned unexpected shape: ${JSON.stringify(result)}`)
        }
    }

    return allVectors
}

/**
 * Chunk, embed, and upsert a document into Vectorize.
 */
export async function indexDocument(
    ai: WorkersAi,
    vectorize: VectorizeIndexBinding,
    documentId: string,
    docName: string,
    content: string,
    conversationId?: string | null
): Promise<{ chunksIndexed: number }> {
    const chunks = chunkText(content)
    if (chunks.length === 0) {
        return { chunksIndexed: 0 }
    }

    const vectors = await getEmbeddings(ai, chunks)

    const vectorizeRecords = chunks.map((chunk, index) => ({
        id: `${documentId}_${index}`,
        values: vectors[index],
        metadata: {
            documentId,
            conversationId: conversationId || "",
            name: docName,
            chunkIndex: index,
            text: chunk.slice(0, 1500), // Keep the full chunk text for RAG prompt context
        },
    }))

    // Upsert in batches of 20
    const upsertBatchSize = 20
    for (let i = 0; i < vectorizeRecords.length; i += upsertBatchSize) {
        const batch = vectorizeRecords.slice(i, i + upsertBatchSize)
        await vectorize.upsert(batch)
    }

    return { chunksIndexed: chunks.length }
}

export interface RetrievedChunk {
    score: number
    documentId: string
    conversationId?: string
    name: string
    chunkIndex: number
    text: string
}

/**
 * Query Vectorize using query text embedded with BGE model.
 */
export async function queryKnowledge(
    ai: WorkersAi,
    vectorize: VectorizeIndexBinding,
    query: string,
    topK: number = 5,
    selectedDocIds?: string[]
): Promise<RetrievedChunk[]> {
    const queryVectors = await getEmbeddings(ai, [query])
    if (!queryVectors || queryVectors.length === 0) {
        return []
    }

    const queryVector = queryVectors[0]
    let searchResult: VectorizeQueryResult | null = null

    // If specific documents are selected, filter Vectorize query to those document IDs
    if (selectedDocIds && selectedDocIds.length > 0) {
        try {
            const filter =
                selectedDocIds.length === 1
                    ? { documentId: selectedDocIds[0] }
                    : { documentId: { $in: selectedDocIds } }
            searchResult = await vectorize.query(queryVector, {
                topK,
                returnMetadata: "all",
                filter,
            })
        } catch {
            // Index might not have filterable metadata property configured; fall back to broader query
            searchResult = null
        }
    }

    if (!searchResult) {
        searchResult = await vectorize.query(queryVector, {
            topK: selectedDocIds && selectedDocIds.length > 0 ? Math.max(topK, 30) : topK,
            returnMetadata: "all",
        })
    }

    if (!searchResult || !Array.isArray(searchResult.matches)) {
        return []
    }

    const results: RetrievedChunk[] = searchResult.matches.map((m: VectorizeMatch) => ({
        score: m.score,
        documentId: String(m.metadata?.documentId || ""),
        conversationId: String(m.metadata?.conversationId || ""),
        name: String(m.metadata?.name || "Document"),
        chunkIndex: Number(m.metadata?.chunkIndex || 0),
        text: String(m.metadata?.text || ""),
    }))

    if (selectedDocIds && selectedDocIds.length > 0) {
        return results.filter(
            (r: RetrievedChunk) => r.documentId && selectedDocIds.includes(r.documentId)
        )
    }

    return results
}

/**
 * Delete vectors associated with a document.
 */
export async function deleteDocumentVectors(
    vectorize: VectorizeIndexBinding,
    documentId: string,
    chunkCount?: number | null
): Promise<void> {
    try {
        const count = Math.max(chunkCount && chunkCount > 0 ? chunkCount : 50, 50)
        const batchSize = 100
        for (let start = 0; start < count; start += batchSize) {
            const end = Math.min(start + batchSize, count)
            const ids: string[] = []
            for (let i = start; i < end; i++) {
                ids.push(`${documentId}_${i}`)
            }
            await vectorize.deleteByIds(ids)
        }
    } catch {
        // Vector deletion is best-effort and asynchronous in Vectorize
    }
}
