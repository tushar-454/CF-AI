import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers"
import { extractPdfDocument } from "./pdf"
import { chunkPages, chunkText, getEmbeddings } from "./rag"
import { failDocument, getDocument, updateDocumentProgress } from "./db"
import type {
    AppEnv,
    DocumentChunk,
    DocumentProgressEvent,
    DocumentStage,
    VectorizeIndexBinding,
} from "./types"

export interface PdfWorkflowParams {
    documentId: string
    r2Key: string
    fileName: string
    conversationId?: string | null
}

async function publishProgressEvent(env: AppEnv, event: DocumentProgressEvent): Promise<void> {
    try {
        if (!env.DOCUMENT_PROGRESS_DO) return
        const doId = env.DOCUMENT_PROGRESS_DO.idFromName(event.documentId)
        const stub = env.DOCUMENT_PROGRESS_DO.get(doId)

        if (typeof stub.reportProgress === "function") {
            await stub.reportProgress(event)
        } else {
            await stub.fetch("https://internal/event", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(event),
            })
        }
    } catch (err) {
        console.warn(`[Workflow] Failed to publish progress event for ${event.documentId}:`, err)
    }
}

export class PdfProcessingWorkflow extends WorkflowEntrypoint<AppEnv, PdfWorkflowParams> {
    async run(event: WorkflowEvent<PdfWorkflowParams>, step: WorkflowStep): Promise<void> {
        const { documentId, r2Key, fileName, conversationId } = event.payload
        let currentStage: DocumentStage = "upload"
        let currentProgress = 0

        const report = async (
            stage: DocumentStage,
            progress: number,
            message?: string,
            extras?: Partial<DocumentProgressEvent>
        ) => {
            currentStage = stage
            currentProgress = progress
            const progressEvent: DocumentProgressEvent = {
                documentId,
                status: "processing",
                stage,
                progress,
                message,
                timestamp: Date.now(),
                ...extras,
            }
            await updateDocumentProgress(
                documentId,
                {
                    status: "processing",
                    stage,
                    progress,
                },
                this.env.DB
            )
            await publishProgressEvent(this.env, progressEvent)
        }

        try {
            // Step 1: Initialize processing & verify R2 object
            await step.do("initialize-processing", async () => {
                if (!documentId || !r2Key) {
                    throw new Error(
                        "Invalid Workflow parameters: documentId and r2Key are required."
                    )
                }
                const r2 = this.env.FILES
                if (!r2) {
                    throw new Error("R2 storage binding (FILES) is missing.")
                }
                const obj = await r2.get(r2Key)
                if (!obj) {
                    throw new Error(`Referenced object ${r2Key} not found in R2 storage.`)
                }

                await report(
                    "extraction",
                    10,
                    `Validated "${fileName}" in storage. Starting text extraction.`
                )
                return { size: obj.size }
            })

            // Step 2: Extract PDF pages and plain text with unpdf & conditional OCR
            const extractedTextKey = `intermediates/${documentId}/extracted.txt`
            const pagesKey = `intermediates/${documentId}/pages.json`
            const metaKey = `intermediates/${documentId}/meta.json`

            const extractionResult = await step.do("extract-pdf-text", async () => {
                const r2 = this.env.FILES!
                const obj = await r2.get(r2Key)
                if (!obj) {
                    throw new Error(`PDF file ${r2Key} missing from R2 during extraction.`)
                }

                const arrayBuffer = await obj.arrayBuffer()
                const extractedDoc = await extractPdfDocument(arrayBuffer, {
                    ai: this.env.AI,
                    enableOcr: true,
                    maxOcrPages: 10,
                    ocrConcurrency: 2,
                })

                const { pages, totalPages, extractionMode, ocrPagesCount, contentHash } =
                    extractedDoc
                const text = pages.map((p) => p.text).join("\n\n")

                if (!text || !text.trim()) {
                    throw new Error(
                        `No extractable text or images found in "${fileName}". The PDF may be empty or corrupted.`
                    )
                }

                // Check for idempotent re-processing: has content changed since a previous run?
                let isContentUnchanged = false
                try {
                    const prevMetaObj = await r2.get(metaKey)
                    if (prevMetaObj) {
                        const prevRaw = prevMetaObj.text
                            ? await prevMetaObj.text()
                            : new TextDecoder().decode(await prevMetaObj.arrayBuffer())
                        const prevMeta = JSON.parse(prevRaw)
                        if (
                            prevMeta.contentHash &&
                            prevMeta.contentHash === contentHash &&
                            prevMeta.isIndexed
                        ) {
                            isContentUnchanged = true
                        }
                    }
                } catch {}

                // Save extraction metadata for idempotency and auditability
                const metaPayload = {
                    documentId,
                    fileName,
                    totalPages,
                    extractionMode,
                    ocrPagesCount,
                    contentHash,
                    isContentUnchanged,
                    updatedAt: Date.now(),
                }
                await r2.put(metaKey, JSON.stringify(metaPayload), {
                    httpMetadata: { contentType: "application/json" },
                    customMetadata: { documentId, contentHash },
                })

                // Save extracted text to R2 to prevent Workflow step state payload limit
                await r2.put(extractedTextKey, text.trim(), {
                    httpMetadata: { contentType: "text/plain; charset=utf-8" },
                    customMetadata: { documentId, fileName },
                })
                await r2.put(`extracted/${documentId}.txt`, text.trim(), {
                    httpMetadata: { contentType: "text/plain; charset=utf-8" },
                    customMetadata: { documentId, fileName },
                })

                // Save page-by-page breakdown for page citations and vectorized metadata
                await r2.put(pagesKey, JSON.stringify(pages), {
                    httpMetadata: { contentType: "application/json" },
                    customMetadata: { documentId, fileName, totalPages: String(pages.length) },
                })

                const modeLabel =
                    extractionMode === "ocr"
                        ? `Scanned document (${ocrPagesCount} page(s) OCR'd)`
                        : extractionMode === "mixed"
                          ? `Mixed document (${ocrPagesCount} page(s) OCR'd of ${totalPages})`
                          : `Text document (${totalPages} page(s))`

                await report(
                    "chunking",
                    30,
                    `Extracted ${pages.length} page(s) from "${fileName}" [${modeLabel}]. Preparing chunks.`
                )

                return {
                    textLength: text.length,
                    totalPages: pages.length,
                    contentHash,
                    isContentUnchanged,
                }
            })

            // Step 3: Chunk text using natural boundaries, preserving page numbers
            const chunksKey = `intermediates/${documentId}/chunks.json`
            const chunkMeta = await step.do("chunk-extracted-text", async () => {
                const r2 = this.env.FILES!
                const pagesObj = await r2.get(pagesKey)
                let chunks: DocumentChunk[] = []

                if (pagesObj) {
                    const rawPages = await (pagesObj.text
                        ? pagesObj.text()
                        : new TextDecoder().decode(await pagesObj.arrayBuffer()))
                    const pages = JSON.parse(rawPages) as Array<{
                        pageNumber: number
                        text: string
                    }>
                    if (Array.isArray(pages) && pages.length > 0) {
                        chunks = chunkPages(pages)
                    }
                }

                if (chunks.length === 0) {
                    const textObj = await r2.get(extractedTextKey)
                    if (!textObj) {
                        throw new Error("Intermediate extracted text missing from R2.")
                    }
                    const text = await (textObj.text
                        ? textObj.text()
                        : new TextDecoder().decode(await textObj.arrayBuffer()))
                    const strChunks = chunkText(text)
                    chunks = strChunks.map((c) => ({ text: c, pageNumber: 1 }))
                }

                if (chunks.length === 0) {
                    throw new Error(`Could not generate readable text chunks from "${fileName}".`)
                }

                await r2.put(chunksKey, JSON.stringify(chunks), {
                    httpMetadata: { contentType: "application/json" },
                    customMetadata: { documentId, chunkCount: String(chunks.length) },
                })

                await report(
                    "embedding",
                    50,
                    `Created ${chunks.length} text chunks across pages. Generating embeddings.`,
                    {
                        totalChunks: chunks.length,
                    }
                )

                return { totalChunks: chunks.length }
            })

            // Step 4: Generate embeddings via Workers AI in bounded batches (skips if content unchanged)
            const vectorsKey = `intermediates/${documentId}/vectors.json`
            const embeddingResult = await step.do(
                "generate-embeddings",
                {
                    retries: {
                        limit: 2,
                        delay: "2 seconds",
                        backoff: "exponential",
                    },
                },
                async () => {
                    const r2 = this.env.FILES!
                    const ai = this.env.AI
                    if (!ai) {
                        throw new Error("Workers AI binding (AI) is missing or unavailable.")
                    }

                    // Check if document was already fully indexed and content is identical
                    const doc = await getDocument(documentId, this.env.DB).catch(() => null)
                    if (
                        extractionResult.isContentUnchanged &&
                        doc?.status === "ready" &&
                        doc?.chunk_count === chunkMeta.totalChunks
                    ) {
                        console.log(
                            `[Workflow] Document ${documentId} content unchanged and already indexed. Skipping embedding generation.`
                        )
                        return { vectorCount: chunkMeta.totalChunks, skipped: true }
                    }

                    const chunksObj = await r2.get(chunksKey)
                    if (!chunksObj) {
                        throw new Error("Intermediate chunks file missing from R2.")
                    }

                    const rawChunks = await (chunksObj.text
                        ? chunksObj.text()
                        : new TextDecoder().decode(await chunksObj.arrayBuffer()))
                    const parsed = JSON.parse(rawChunks) as Array<
                        string | { text: string; pageNumber?: number }
                    >
                    const chunkTexts = parsed.map((c) => (typeof c === "string" ? c : c.text))

                    const vectors = await getEmbeddings(ai, chunkTexts)

                    await r2.put(vectorsKey, JSON.stringify(vectors), {
                        httpMetadata: { contentType: "application/json" },
                        customMetadata: { documentId, vectorCount: String(vectors.length) },
                    })

                    await report(
                        "indexing",
                        75,
                        `Computed vector embeddings for ${parsed.length} chunks. Indexing into Vectorize.`,
                        {
                            totalChunks: parsed.length,
                        }
                    )

                    return { vectorCount: vectors.length, skipped: false }
                }
            )

            // Step 5: Upsert vectors into Vectorize with clean orphan vector cleanup
            await step.do(
                "index-vectors",
                {
                    retries: {
                        limit: 2,
                        delay: "2 seconds",
                        backoff: "exponential",
                    },
                },
                async () => {
                    const r2 = this.env.FILES!
                    const vectorize = this.env.VECTORIZE as VectorizeIndexBinding | undefined
                    if (!vectorize || typeof vectorize.upsert !== "function") {
                        throw new Error("Vectorize binding (VECTORIZE) is missing or unconfigured.")
                    }

                    const doc = await getDocument(documentId, this.env.DB).catch(() => null)
                    const oldChunkCount = doc?.chunk_count || 0
                    const newChunkCount = chunkMeta.totalChunks

                    // If previously indexed with more chunks, delete obsolete trailing vector IDs
                    if (
                        oldChunkCount > newChunkCount &&
                        typeof vectorize.deleteByIds === "function"
                    ) {
                        const orphanIds: string[] = []
                        for (let i = newChunkCount; i < oldChunkCount; i++) {
                            orphanIds.push(`${documentId}_${i}`)
                        }
                        await vectorize.deleteByIds(orphanIds).catch((delErr) => {
                            console.warn(
                                `[Workflow] Failed to delete orphan vectors for ${documentId}:`,
                                delErr
                            )
                        })
                    }

                    // If embedding generation was skipped because content is already indexed
                    if (embeddingResult.skipped) {
                        console.log(
                            `[Workflow] Document ${documentId} index already up to date. Skipping Vectorize upsert.`
                        )
                        return { chunksIndexed: newChunkCount, skipped: true }
                    }

                    const chunksObj = await r2.get(chunksKey)
                    const vectorsObj = await r2.get(vectorsKey)
                    if (!chunksObj || !vectorsObj) {
                        throw new Error("Intermediate chunks or vectors missing from R2.")
                    }

                    const rawChunks = await (chunksObj.text
                        ? chunksObj.text()
                        : new TextDecoder().decode(await chunksObj.arrayBuffer()))
                    const rawVectors = await (vectorsObj.text
                        ? vectorsObj.text()
                        : new TextDecoder().decode(await vectorsObj.arrayBuffer()))

                    const parsed = JSON.parse(rawChunks) as Array<
                        string | { text: string; pageNumber?: number }
                    >
                    const chunks: DocumentChunk[] = parsed.map((c) =>
                        typeof c === "string"
                            ? { text: c, pageNumber: 1 }
                            : { text: c.text, pageNumber: c.pageNumber ?? 1 }
                    )
                    const vectors = JSON.parse(rawVectors) as number[][]

                    const records = chunks.map((chunk, index) => ({
                        id: `${documentId}_${index}`,
                        values: vectors[index],
                        metadata: {
                            documentId,
                            conversationId: conversationId || "",
                            name: fileName,
                            chunkIndex: index,
                            pageNumber: chunk.pageNumber ?? 1,
                            text: chunk.text.slice(0, 1500),
                        },
                    }))

                    // Upsert in batches of 20
                    const batchSize = 20
                    for (let i = 0; i < records.length; i += batchSize) {
                        const batch = records.slice(i, i + batchSize)
                        await vectorize.upsert(batch)
                    }

                    await report(
                        "indexing",
                        95,
                        `Indexed ${records.length} vector records in Vectorize. Finalizing document.`,
                        {
                            chunksIndexed: records.length,
                            totalChunks: records.length,
                        }
                    )

                    return { chunksIndexed: records.length, skipped: false }
                }
            )

            // Step 6: Mark ready and cleanup intermediate files
            await step.do("mark-ready-and-cleanup", async () => {
                const now = Date.now()
                await updateDocumentProgress(
                    documentId,
                    {
                        status: "ready",
                        stage: "ready",
                        progress: 100,
                        completed_at: now,
                        chunk_count: chunkMeta.totalChunks,
                    },
                    this.env.DB
                )

                // Update meta.json with isIndexed flag
                try {
                    const r2 = this.env.FILES
                    if (r2) {
                        const metaObj = await r2.get(metaKey)
                        if (metaObj) {
                            const rawMeta = await (metaObj.text
                                ? metaObj.text()
                                : new TextDecoder().decode(await metaObj.arrayBuffer()))
                            const metaData = JSON.parse(rawMeta)
                            metaData.isIndexed = true
                            metaData.totalChunks = chunkMeta.totalChunks
                            await r2.put(metaKey, JSON.stringify(metaData), {
                                httpMetadata: { contentType: "application/json" },
                            })
                        }
                        // Clean up intermediate raw vectors file in R2 (best-effort)
                        await r2.delete([vectorsKey])
                    }
                } catch (cleanupErr) {
                    console.warn(
                        `[Workflow] Intermediate cleanup warning for ${documentId}:`,
                        cleanupErr
                    )
                }

                // Publish final ready success event
                const readyEvent: DocumentProgressEvent = {
                    documentId,
                    status: "ready",
                    stage: "ready",
                    progress: 100,
                    message: `"${fileName}" is fully indexed and ready for chat.`,
                    completedAt: now,
                    timestamp: now,
                    chunksIndexed: chunkMeta.totalChunks,
                    totalChunks: chunkMeta.totalChunks,
                }
                await publishProgressEvent(this.env, readyEvent)

                return { success: true }
            })
        } catch (error: unknown) {
            const rawMsg = error instanceof Error ? error.message : String(error)

            const doc = await getDocument(documentId, this.env.DB).catch(() => null)
            const failedStage: DocumentStage = doc?.stage || currentStage || "failed"
            const failedProgress = doc?.progress ?? currentProgress

            console.error(
                `[Workflow Error] Document ${documentId} failed in stage "${failedStage}":`,
                error
            )

            let safeMsg = rawMsg
            if (safeMsg.includes("REPLACE_WITH_") || safeMsg.includes("missing or unconfigured")) {
                safeMsg = "Cloudflare service binding is not configured."
            }

            await failDocument(documentId, safeMsg, failedStage, this.env.DB)

            const failEvent: DocumentProgressEvent = {
                documentId,
                status: "failed",
                stage: failedStage,
                progress: failedProgress,
                error: safeMsg,
                timestamp: Date.now(),
            }
            await publishProgressEvent(this.env, failEvent)

            try {
                const r2 = this.env.FILES
                if (r2) {
                    await r2.delete([`intermediates/${documentId}/vectors.json`])
                }
            } catch {}

            throw error
        }
    }
}
