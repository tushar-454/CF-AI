import { getR2 } from "@/lib/ai"
import { verifyPin } from "@/lib/auth"
import { createDocument, failDocument } from "@/lib/db"
import { isPdfFile } from "@/lib/pdf"
import { chunkText, indexDocument } from "@/lib/rag"
import { AppEnv } from "@/lib/types"
import { env } from "cloudflare:workers"

const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10 MB

const TEXT_MIME_PATTERNS = [
    /^text\//,
    /application\/json/,
    /application\/javascript/,
    /application\/typescript/,
    /application\/xml/,
    /application\/x-sh/,
    /application\/x-yaml/,
    /application\/sql/,
    /application\/csv/,
]

function isTextFile(mime: string, filename: string): boolean {
    if (TEXT_MIME_PATTERNS.some((pat) => pat.test(mime))) return true
    const ext = filename.split(".").pop()?.toLowerCase()
    const textExtensions = [
        "txt",
        "md",
        "markdown",
        "json",
        "js",
        "jsx",
        "ts",
        "tsx",
        "css",
        "html",
        "htm",
        "csv",
        "yaml",
        "yml",
        "py",
        "rs",
        "go",
        "java",
        "c",
        "cpp",
        "h",
        "sh",
        "sql",
        "env",
        "xml",
    ]
    return ext ? textExtensions.includes(ext) : false
}

export async function POST(req: Request) {
    try {
        const pin = req.headers.get("x-app-pin")
        if (!verifyPin(pin, req)) {
            return Response.json(
                { error: "Unauthorized. Please enter the correct 4-digit security PIN." },
                { status: 401 }
            )
        }

        const formData = await req.formData()
        const file = formData.get("file")
        const rawConversationId =
            (formData.get("conversationId") as string) ||
            (formData.get("conversation_id") as string) ||
            null
        const conversationId =
            rawConversationId && rawConversationId.trim() ? rawConversationId.trim() : null

        if (!file || !(file instanceof File)) {
            return Response.json(
                { error: "No file provided in form-data field 'file'" },
                { status: 400 }
            )
        }

        if (file.size > MAX_FILE_SIZE) {
            return Response.json(
                {
                    error: `File size exceeds the 10 MB limit (${(file.size / (1024 * 1024)).toFixed(1)} MB)`,
                },
                { status: 413 }
            )
        }

        const documentId = crypto.randomUUID()
        const ext = file.name.split(".").pop() || "bin"
        const r2Key = `uploads/${documentId}.${ext}`
        const isImage = file.type.startsWith("image/")
        const isPdf = isPdfFile(file.type, file.name)
        const isText = !isPdf && isTextFile(file.type, file.name)

        const contentType =
            file.type ||
            (isPdf ? "application/pdf" : isText ? "text/plain" : "application/octet-stream")

        // Stream directly into R2 bucket without allocating a full ArrayBuffer in Worker RAM
        const r2 = getR2()
        await r2.put(r2Key, file.stream(), {
            httpMetadata: {
                contentType,
            },
            customMetadata: {
                originalName: file.name,
                documentId,
                conversationId: conversationId || "",
            },
        })

        let extractedText = ""
        const appEnv = env as unknown as AppEnv
        const ai = appEnv.AI
        const vectorize = appEnv.VECTORIZE

        if (isPdf) {
            // Record document in D1 as queued before starting Workflow
            try {
                await createDocument({
                    id: documentId,
                    conversation_id: conversationId,
                    name: file.name,
                    r2_key: r2Key,
                    mime: contentType,
                    size: file.size,
                    status: "queued",
                    stage: "upload",
                    progress: 0,
                    created_at: Date.now(),
                })
            } catch (dbErr: unknown) {
                const msg = dbErr instanceof Error ? dbErr.message : String(dbErr)
                console.warn("D1 could not record queued PDF document:", msg)
            }

            // Seed initial state in Durable Object
            if (appEnv.DOCUMENT_PROGRESS_DO) {
                try {
                    const doId = appEnv.DOCUMENT_PROGRESS_DO.idFromName(documentId)
                    const stub = appEnv.DOCUMENT_PROGRESS_DO.get(doId)
                    if (typeof stub.reportProgress === "function") {
                        await stub.reportProgress({
                            documentId,
                            status: "queued",
                            stage: "upload",
                            progress: 0,
                            message: `Uploaded "${file.name}". Starting background processing pipeline.`,
                            timestamp: Date.now(),
                        })
                    }
                } catch (doErr) {
                    console.warn("Could not seed DO state:", doErr)
                }
            }

            // Start Cloudflare Workflow with small, serializable parameters
            if (appEnv.PDF_WORKFLOW) {
                try {
                    await appEnv.PDF_WORKFLOW.create({
                        id: documentId,
                        params: {
                            documentId,
                            r2Key,
                            fileName: file.name,
                            conversationId,
                        },
                    })
                } catch (wfErr: unknown) {
                    console.error("Failed to trigger PDF_WORKFLOW:", wfErr)
                    await failDocument(
                        documentId,
                        "Failed to trigger background processing workflow",
                        "upload"
                    ).catch(() => {})
                    await r2.delete(r2Key).catch(() => {})
                    throw wfErr
                }
            } else {
                console.warn(
                    "PDF_WORKFLOW binding is not available in current environment. Background processing queued."
                )
            }

            return Response.json({
                id: documentId,
                conversation_id: conversationId,
                name: file.name,
                mime: contentType,
                size: file.size,
                r2_key: r2Key,
                isImage: false,
                isPdf: true,
                status: "queued",
                stage: "upload",
                progress: 0,
                url: `/api/files/${documentId}`,
                r2_url: `/api/r2?key=${encodeURIComponent(r2Key)}`,
                progress_url: `/api/files/${documentId}/progress`,
            })
        }

        const status: "ready" | "image" = isImage ? "image" : "ready"

        if (isText) {
            try {
                extractedText = await file.text()
            } catch (decodeErr) {
                console.warn("Failed to decode text file:", decodeErr)
            }
        }

        // Save extracted text & pre-computed chunks to R2 for resilient RAG retrieval
        if (extractedText.trim()) {
            try {
                await r2.put(`extracted/${documentId}.txt`, extractedText.trim(), {
                    httpMetadata: { contentType: "text/plain; charset=utf-8" },
                    customMetadata: { documentId, fileName: file.name },
                })
                await r2.put(`intermediates/${documentId}/extracted.txt`, extractedText.trim(), {
                    httpMetadata: { contentType: "text/plain; charset=utf-8" },
                    customMetadata: { documentId, fileName: file.name },
                })
                const chunks = chunkText(extractedText)
                if (chunks.length > 0) {
                    await r2.put(`intermediates/${documentId}/chunks.json`, JSON.stringify(chunks), {
                        httpMetadata: { contentType: "application/json" },
                        customMetadata: { documentId, chunkCount: String(chunks.length) },
                    })
                }
            } catch (r2Err) {
                console.warn("Failed to store text document chunks in R2:", r2Err)
            }
        }

        // If Vectorize and AI bindings are available, index the text into the global Vectorize index
        if (ai && vectorize && extractedText.trim()) {
            try {
                const result = await indexDocument(
                    ai,
                    vectorize,
                    documentId,
                    file.name,
                    extractedText,
                    null
                )
                console.log(
                    `Indexed "${file.name}" with ${result.chunksIndexed} chunk(s) into Vectorize.`
                )
            } catch (ragErr) {
                console.warn(
                    "Could not index document in Vectorize (likely placeholder config):",
                    ragErr
                )
            }
        }

        // Record non-PDF document in D1 under global knowledge base
        try {
            await createDocument({
                id: documentId,
                conversation_id: conversationId,
                name: file.name,
                r2_key: r2Key,
                mime: contentType,
                size: file.size,
                status,
                stage: "ready",
                progress: 100,
                created_at: Date.now(),
            })
        } catch (dbErr: unknown) {
            const msg = dbErr instanceof Error ? dbErr.message : String(dbErr)
            console.warn("D1 could not record document:", msg)
        }

        return Response.json({
            id: documentId,
            conversation_id: conversationId,
            name: file.name,
            mime: contentType,
            size: file.size,
            r2_key: r2Key,
            isImage,
            isPdf: false,
            url: `/api/files/${documentId}`,
            r2_url: `/api/r2?key=${encodeURIComponent(r2Key)}`,
            status,
            stage: "ready",
            progress: 100,
            textContent: extractedText ? extractedText.slice(0, 16000) : undefined,
        })
    } catch (error: unknown) {
        console.error("Error in POST /api/upload:", error)
        const isBindingError =
            error instanceof Error &&
            (error.name === "R2BindingError" ||
                error.name === "DatabaseBindingError" ||
                error.message.includes("REPLACE_WITH_"))
        const errorMessage = error instanceof Error ? error.message : "File upload failed"

        return Response.json(
            {
                error: errorMessage,
                isBindingError: Boolean(isBindingError),
            },
            { status: isBindingError ? 503 : 500 }
        )
    }
}
