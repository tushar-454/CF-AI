import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers"
import { extractPdfText } from "./pdf"
import { chunkText, getEmbeddings } from "./rag"
import { failDocument, getDocument, updateDocumentProgress } from "./db"
import type { AppEnv, DocumentProgressEvent, DocumentStage, VectorizeIndexBinding } from "./types"

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

            // Step 2: Extract PDF plain text (deterministic: do not retry permanent text extraction failures)
            const extractedTextKey = `intermediates/${documentId}/extracted.txt`
            await step.do("extract-pdf-text", async () => {
                const r2 = this.env.FILES!
                const obj = await r2.get(r2Key)
                if (!obj) {
                    throw new Error(`PDF file ${r2Key} missing from R2 during extraction.`)
                }

                const arrayBuffer = await obj.arrayBuffer()
                const text = await extractPdfText(arrayBuffer, this.env.AI)

                if (!text || !text.trim()) {
                    throw new Error(
                        `No extractable text layer found in "${fileName}". The PDF may be empty or a scanned image requiring OCR.`
                    )
                }

                // Save extracted text to R2 to prevent Workflow step state payload limit and provide permanent RAG fallback
                await r2.put(extractedTextKey, text.trim(), {
                    httpMetadata: { contentType: "text/plain; charset=utf-8" },
                    customMetadata: { documentId, fileName },
                })
                await r2.put(`extracted/${documentId}.txt`, text.trim(), {
                    httpMetadata: { contentType: "text/plain; charset=utf-8" },
                    customMetadata: { documentId, fileName },
                })

                await report("chunking", 30, `Extracted text from "${fileName}". Preparing chunks.`)
                return { textLength: text.length }
            })

            // Step 3: Chunk text using natural boundaries
            const chunksKey = `intermediates/${documentId}/chunks.json`
            const chunkMeta = await step.do("chunk-extracted-text", async () => {
                const r2 = this.env.FILES!
                const textObj = await r2.get(extractedTextKey)
                if (!textObj) {
                    throw new Error("Intermediate extracted text missing from R2.")
                }
                const text = await (textObj.text
                    ? textObj.text()
                    : new TextDecoder().decode(await textObj.arrayBuffer()))
                const chunks = chunkText(text)

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
                    `Created ${chunks.length} text chunks. Generating embeddings.`,
                    {
                        totalChunks: chunks.length,
                    }
                )

                return { totalChunks: chunks.length }
            })

            // Step 4: Generate embeddings via Workers AI in bounded batches
            const vectorsKey = `intermediates/${documentId}/vectors.json`
            await step.do(
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

                    const chunksObj = await r2.get(chunksKey)
                    if (!chunksObj) {
                        throw new Error("Intermediate chunks file missing from R2.")
                    }

                    const rawChunks = await (chunksObj.text
                        ? chunksObj.text()
                        : new TextDecoder().decode(await chunksObj.arrayBuffer()))
                    const chunks = JSON.parse(rawChunks) as string[]

                    const vectors = await getEmbeddings(ai, chunks)

                    await r2.put(vectorsKey, JSON.stringify(vectors), {
                        httpMetadata: { contentType: "application/json" },
                        customMetadata: { documentId, vectorCount: String(vectors.length) },
                    })

                    await report(
                        "indexing",
                        75,
                        `Computed vector embeddings for ${chunks.length} chunks. Indexing into Vectorize.`,
                        {
                            totalChunks: chunks.length,
                        }
                    )

                    return { vectorCount: vectors.length }
                }
            )

            // Step 5: Upsert vectors into Vectorize with batching
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

                    const chunks = JSON.parse(rawChunks) as string[]
                    const vectors = JSON.parse(rawVectors) as number[][]

                    const records = chunks.map((chunk, index) => ({
                        id: `${documentId}_${index}`,
                        values: vectors[index],
                        metadata: {
                            documentId,
                            conversationId: conversationId || "",
                            name: fileName,
                            chunkIndex: index,
                            text: chunk.slice(0, 1500),
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

                    return { chunksIndexed: records.length }
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

                // Clean up intermediate raw vectors file in R2 (best-effort);
                // We intentionally preserve extractedTextKey and chunksKey for direct RAG prompt retrieval!
                try {
                    const r2 = this.env.FILES
                    if (r2) {
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

            // Query authoritative document stage and progress from D1 so workflow resume
            // does not falsely overwrite the stage to "upload" with 0 progress
            const doc = await getDocument(documentId, this.env.DB).catch(() => null)
            const failedStage: DocumentStage = doc?.stage || currentStage || "failed"
            const failedProgress = doc?.progress ?? currentProgress

            console.error(
                `[Workflow Error] Document ${documentId} failed in stage "${failedStage}":`,
                error
            )

            // Safe user-facing error message (avoid leaking internal credentials or stack traces)
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

            // Clean up temporary vectors on terminal failure (best effort)
            try {
                const r2 = this.env.FILES
                if (r2) {
                    await r2.delete([`intermediates/${documentId}/vectors.json`])
                }
            } catch {}

            // Re-throw so Workflow registers terminal failure in Cloudflare dashboard
            throw error
        }
    }
}

