import { env } from "cloudflare:workers"
import { EMBEDDING_MODEL_ID } from "./models"
import { extractPdfText } from "./pdf"
import type {
    AppEnv,
    DocumentChunk,
    R2BucketBinding,
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
 * Split text pages into chunks while preserving originating PDF page numbers.
 */
export function chunkPages(
    pages: Array<{ pageNumber: number; text: string }>,
    chunkSize: number = 800,
    overlap: number = 100
): DocumentChunk[] {
    const chunks: DocumentChunk[] = []
    for (const page of pages) {
        const pageChunks = chunkText(page.text, chunkSize, overlap)
        for (const chunk of pageChunks) {
            chunks.push({
                text: chunk,
                pageNumber: page.pageNumber,
            })
        }
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
    conversationId?: string | null,
    pageNumber?: number
): Promise<{ chunksIndexed: number }> {
    const stringChunks = chunkText(content)
    const chunks: DocumentChunk[] = stringChunks.map((text) => ({
        text,
        pageNumber: pageNumber ?? 1,
    }))
    return indexDocumentChunks(ai, vectorize, documentId, docName, chunks, conversationId)
}

/**
 * Chunk, embed, and upsert pre-structured chunks (with page numbers) into Vectorize.
 */
export async function indexDocumentChunks(
    ai: WorkersAi,
    vectorize: VectorizeIndexBinding,
    documentId: string,
    docName: string,
    chunks: DocumentChunk[],
    conversationId?: string | null
): Promise<{ chunksIndexed: number }> {
    if (chunks.length === 0) {
        return { chunksIndexed: 0 }
    }

    const texts = chunks.map((c) => c.text)
    const vectors = await getEmbeddings(ai, texts)

    const vectorizeRecords = chunks.map((chunk, index) => ({
        id: `${documentId}_${index}`,
        values: vectors[index],
        metadata: {
            documentId,
            conversationId: conversationId || "",
            name: docName,
            chunkIndex: index,
            pageNumber: chunk.pageNumber ?? 1,
            text: chunk.text.slice(0, 1500), // Keep the full chunk text for RAG prompt context
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
    pageNumber?: number
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
            topK: selectedDocIds && selectedDocIds.length > 0 ? Math.max(topK, 50) : topK,
            returnMetadata: "all",
        })
    }

    if (!searchResult || !Array.isArray(searchResult.matches)) {
        return []
    }

    const results: RetrievedChunk[] = searchResult.matches.map((m: VectorizeMatch) => {
        const idDocId = m.id.includes("_") ? m.id.substring(0, m.id.lastIndexOf("_")) : m.id
        const docId = String(m.metadata?.documentId || idDocId || "")
        const pageNum =
            m.metadata?.pageNumber !== undefined && m.metadata?.pageNumber !== null
                ? Number(m.metadata.pageNumber)
                : undefined
        return {
            score: m.score,
            documentId: docId,
            conversationId: String(m.metadata?.conversationId || ""),
            name: String(m.metadata?.name || "Document"),
            chunkIndex: Number(m.metadata?.chunkIndex || 0),
            pageNumber: pageNum,
            text: String(m.metadata?.text || ""),
        }
    })

    if (selectedDocIds && selectedDocIds.length > 0) {
        return results.filter(
            (r: RetrievedChunk) =>
                r.documentId &&
                (selectedDocIds.includes(r.documentId) ||
                    selectedDocIds.some((id) => r.documentId.startsWith(id)))
        )
    }

    return results
}

/**
 * Retrieve the plain text of a document from R2 storage with layered fallbacks:
 * 1. extracted/${docId}.txt or intermediates/${docId}/extracted.txt
 * 2. intermediates/${docId}/chunks.json
 * 3. On-demand PDF / text extraction from raw R2 object
 */
export async function getDocumentR2Text(
    r2: R2BucketBinding,
    docId: string,
    docName?: string,
    ai?: unknown
): Promise<string> {
    if (!r2) return ""

    // 1. Check extracted text file
    try {
        const extractedObj =
            (await r2.get(`extracted/${docId}.txt`)) ||
            (await r2.get(`intermediates/${docId}/extracted.txt`))
        if (extractedObj) {
            const text = extractedObj.text
                ? await extractedObj.text()
                : new TextDecoder().decode(await extractedObj.arrayBuffer())
            if (text.trim()) return text.trim()
        }
    } catch {}

    // 2. Check chunks.json
    try {
        const chunksObj = await r2.get(`intermediates/${docId}/chunks.json`)
        if (chunksObj) {
            const raw = chunksObj.text
                ? await chunksObj.text()
                : new TextDecoder().decode(await chunksObj.arrayBuffer())
            const parsed = JSON.parse(raw) as Array<string | { text: string }>
            if (Array.isArray(parsed) && parsed.length > 0) {
                return parsed
                    .map((item) => (typeof item === "string" ? item : item.text || ""))
                    .join("\n\n")
            }
        }
    } catch {}

    // 3. Fallback: read original file from R2 and extract on the fly
    try {
        let rawObj = await r2.get(`uploads/${docId}.pdf`)
        let isPdf = true
        if (!rawObj) {
            const list = await r2.list({ prefix: `uploads/${docId}`, limit: 5 })
            if (list.objects.length > 0) {
                const targetKey = list.objects[0].key
                rawObj = await r2.get(targetKey)
                isPdf =
                    targetKey.toLowerCase().endsWith(".pdf") ||
                    (docName?.toLowerCase().endsWith(".pdf") ?? false)
            }
        }

        if (rawObj) {
            if (isPdf) {
                const buf = await rawObj.arrayBuffer()
                const extracted = await extractPdfText(buf, ai)
                if (extracted.trim()) {
                    // Cache the extracted text for next time
                    r2.put(`extracted/${docId}.txt`, extracted.trim(), {
                        httpMetadata: { contentType: "text/plain; charset=utf-8" },
                    }).catch(() => {})
                    return extracted.trim()
                }
            } else {
                const text = rawObj.text
                    ? await rawObj.text()
                    : new TextDecoder().decode(await rawObj.arrayBuffer())
                if (text.trim()) return text.trim()
            }
        }
    } catch (err) {
        console.warn(`Could not extract fallback text for document ${docId}:`, err)
    }

    return ""
}

/**
 * Load document chunks from R2, intelligently scoring them if a query is provided.
 */
export async function getDocumentChunks(
    r2: R2BucketBinding,
    docId: string,
    docName: string,
    query?: string,
    ai?: unknown
): Promise<RetrievedChunk[]> {
    if (!r2) return []

    let chunks: DocumentChunk[] = []

    // 1. Try reading pre-computed chunks
    try {
        const chunksObj = await r2.get(`intermediates/${docId}/chunks.json`)
        if (chunksObj) {
            const raw = chunksObj.text
                ? await chunksObj.text()
                : new TextDecoder().decode(await chunksObj.arrayBuffer())
            const parsed = JSON.parse(raw) as Array<string | { text: string; pageNumber?: number }>
            if (Array.isArray(parsed) && parsed.length > 0) {
                chunks = parsed.map((item) =>
                    typeof item === "string"
                        ? { text: item, pageNumber: 1 }
                        : { text: item.text || "", pageNumber: item.pageNumber ?? 1 }
                )
            }
        }
    } catch {}

    // 2. If no chunks file, check if pages.json exists
    if (chunks.length === 0) {
        try {
            const pagesObj = await r2.get(`intermediates/${docId}/pages.json`)
            if (pagesObj) {
                const rawP = pagesObj.text
                    ? await pagesObj.text()
                    : new TextDecoder().decode(await pagesObj.arrayBuffer())
                const pages = JSON.parse(rawP) as Array<{ pageNumber: number; text: string }>
                if (Array.isArray(pages) && pages.length > 0) {
                    chunks = chunkPages(pages)
                }
            }
        } catch {}
    }

    // 3. Fallback: get document text and chunk it
    if (chunks.length === 0) {
        const text = await getDocumentR2Text(r2, docId, docName, ai)
        if (text) {
            const strChunks = chunkText(text)
            chunks = strChunks.map((str) => ({ text: str, pageNumber: 1 }))
            if (chunks.length > 0) {
                // Asynchronously save chunks to R2 so subsequent queries are fast
                r2.put(`intermediates/${docId}/chunks.json`, JSON.stringify(chunks), {
                    httpMetadata: { contentType: "application/json" },
                    customMetadata: { documentId: docId },
                }).catch(() => {})
            }
        }
    }

    if (chunks.length === 0) return []

    // If query words are present, score chunks by keyword relevance
    const queryTerms = query
        ? query
              .toLowerCase()
              .replace(/[^a-z0-9\s]/g, " ")
              .split(/\s+/)
              .filter(
                  (t) =>
                      t.length >= 3 &&
                      ![
                          "what",
                          "when",
                          "where",
                          "which",
                          "who",
                          "whom",
                          "whose",
                          "why",
                          "how",
                          "this",
                          "that",
                          "these",
                          "those",
                          "about",
                          "document",
                          "file",
                          "pdf",
                          "tell",
                          "explain",
                          "summarize",
                          "give",
                      ].includes(t)
              )
        : []

    interface ScoredIndex {
        index: number
        score: number
        chunk: string
        pageNumber?: number
    }

    const scored: ScoredIndex[] = chunks.map((item, index) => {
        const lowerChunk = item.text.toLowerCase()
        let matchCount = 0
        for (const term of queryTerms) {
            if (lowerChunk.includes(term)) {
                matchCount += 1
            }
        }

        // Bias index 0 (title/intro/summary of document)
        let score = matchCount
        if (index === 0) score += 2
        else if (index === 1) score += 1

        return { index, score, chunk: item.text, pageNumber: item.pageNumber }
    })

    scored.sort((a, b) => b.score - a.score)

    // Take top 4 chunks
    const topScored = scored.slice(0, 4)
    // Sort selected chunks back into reading order (chunkIndex ascending)
    topScored.sort((a, b) => a.index - b.index)

    return topScored.map((item) => ({
        score: item.score,
        documentId: docId,
        name: docName,
        chunkIndex: item.index,
        pageNumber: item.pageNumber,
        text: item.chunk,
    }))
}

/**
 * Unified RAG retrieval: Combines Vectorize similarity search with direct R2 document chunk loading
 * to guarantee that selected document(s) always provide rich, grounded context to the model.
 */
export async function retrieveDocumentContext(
    ai: WorkersAi | undefined,
    vectorize: VectorizeIndexBinding | undefined,
    r2: R2BucketBinding | undefined,
    query: string,
    selectedDocIds: string[],
    docNamesById: Record<string, string> = {}
): Promise<RetrievedChunk[]> {
    if (!selectedDocIds || selectedDocIds.length === 0) {
        return []
    }

    const chunksByDocId = new Map<string, RetrievedChunk[]>()
    for (const id of selectedDocIds) {
        chunksByDocId.set(id, [])
    }

    // 1. Try Vectorize semantic query if bindings are available
    if (ai && vectorize) {
        try {
            const rawVectorChunks = await queryKnowledge(ai, vectorize, query, 20, selectedDocIds)

            for (const chunk of rawVectorChunks) {
                if (chunk.documentId && chunksByDocId.has(chunk.documentId)) {
                    const list = chunksByDocId.get(chunk.documentId)!
                    // Check if chunk text or index already included
                    if (
                        !list.some(
                            (c) => c.chunkIndex === chunk.chunkIndex || c.text === chunk.text
                        )
                    ) {
                        list.push(chunk)
                    }
                }
            }
        } catch (vecErr) {
            console.warn("Vectorize search in retrieveDocumentContext failed:", vecErr)
        }
    }

    // 2. For any selected document with fewer than 2 retrieved chunks, load directly from R2
    if (r2) {
        for (const docId of selectedDocIds) {
            const existing = chunksByDocId.get(docId) || []
            if (existing.length < 2) {
                try {
                    const docName = docNamesById[docId] || "Document"
                    const r2Chunks = await getDocumentChunks(r2, docId, docName, query, ai)
                    for (const r2c of r2Chunks) {
                        if (
                            !existing.some(
                                (c) => c.chunkIndex === r2c.chunkIndex || c.text === r2c.text
                            )
                        ) {
                            existing.push(r2c)
                        }
                    }
                    chunksByDocId.set(docId, existing)
                } catch (r2Err) {
                    console.warn(`Direct R2 chunk load failed for ${docId}:`, r2Err)
                }
            }
        }
    }

    // Flatten and limit to max 8 chunks across all selected documents
    const allChunks: RetrievedChunk[] = []
    for (const [_, list] of chunksByDocId.entries()) {
        allChunks.push(...list.slice(0, 4))
    }

    return allChunks.slice(0, 8)
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
