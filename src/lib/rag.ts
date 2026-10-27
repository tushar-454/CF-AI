import { env } from "cloudflare:workers"
import { EMBEDDING_MODEL_ID } from "./models"

export class VectorizeBindingError extends Error {
    constructor(
        message: string = "Vectorize binding (VECTORIZE) is missing or unconfigured. Please replace REPLACE_WITH_VECTORIZE_INDEX_NAME in cloudflare.config.ts."
    ) {
        super(message)
        this.name = "VectorizeBindingError"
    }
}

export function getVectorize(override?: any): any {
    const index = override || (env as any)?.VECTORIZE
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
export async function getEmbeddings(ai: any, texts: string[]): Promise<number[][]> {
    if (!ai || typeof ai.run !== "function") {
        throw new Error("Workers AI binding (AI) is missing or unavailable.")
    }
    if (texts.length === 0) return []

    const batchSize = 10
    const allVectors: number[][] = []

    for (let i = 0; i < texts.length; i += batchSize) {
        const batch = texts.slice(i, i + batchSize)
        const result = await ai.run(EMBEDDING_MODEL_ID, { text: batch })
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
    ai: any,
    vectorize: any,
    documentId: string,
    docName: string,
    content: string
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
            name: docName,
            chunkIndex: index,
            text: chunk.slice(0, 500), // Keep a snippet for quick display if needed
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
    name: string
    chunkIndex: number
    text: string
}

/**
 * Query Vectorize using query text embedded with BGE model.
 */
export async function queryKnowledge(
    ai: any,
    vectorize: any,
    query: string,
    topK: number = 5
): Promise<RetrievedChunk[]> {
    const queryVectors = await getEmbeddings(ai, [query])
    if (!queryVectors || queryVectors.length === 0) {
        return []
    }

    const queryVector = queryVectors[0]
    const searchResult = await vectorize.query(queryVector, {
        topK,
        returnMetadata: "all",
    })

    if (!searchResult || !Array.isArray(searchResult.matches)) {
        return []
    }

    return searchResult.matches.map((m: any) => ({
        score: m.score,
        documentId: String(m.metadata?.documentId || ""),
        name: String(m.metadata?.name || "Document"),
        chunkIndex: Number(m.metadata?.chunkIndex || 0),
        text: String(m.metadata?.text || ""),
    }))
}

/**
 * Delete vectors associated with a document.
 */
export async function deleteDocumentVectors(
    vectorize: any,
    documentId: string,
    maxChunks: number = 200
): Promise<void> {
    try {
        const ids = Array.from({ length: maxChunks }, (_, i) => `${documentId}_${i}`)
        await vectorize.deleteByIds(ids)
    } catch {
        // Vector deletion is best-effort and asynchronous in Vectorize
    }
}
