import { getR2 } from "@/lib/ai"
import { verifyPin } from "@/lib/auth"
import { createDocument, failDocument, getDocument } from "@/lib/db"
import { isPdfFile } from "@/lib/pdf"
import {
    AppEnv,
    DocumentItem,
    DocumentStatus,
    UploadCompleteRequest,
    UploadCompleteResponse,
} from "@/lib/types"
import { env } from "cloudflare:workers"

const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10 MB

export async function POST(req: Request) {
    try {
        if (!verifyPin(req)) {
            return Response.json(
                { error: "Unauthorized. Please enter the correct 4-digit security PIN." },
                { status: 401 }
            )
        }

        const body = (await req.json().catch(() => ({}))) as Partial<UploadCompleteRequest>
        const { documentId, filename, conversationId = null, mime } = body

        if (!documentId || typeof documentId !== "string" || !documentId.trim()) {
            return Response.json(
                { error: "Invalid completion request: documentId is required." },
                { status: 400 }
            )
        }

        const docName = filename && typeof filename === "string" ? filename.trim() : "document"
        const ext = docName.split(".").pop()?.toLowerCase() || "bin"
        const r2Key = `uploads/${documentId}.${ext}`
        const isPdf = isPdfFile(mime || "", docName)
        const isImage = (mime || "").startsWith("image/")

        const r2 = getR2()
        const obj = await r2.get(r2Key)

        if (!obj) {
            return Response.json(
                { error: `Uploaded file not found in R2 storage at key: ${r2Key}` },
                { status: 400 }
            )
        }

        if (obj.size === 0) {
            await r2.delete(r2Key).catch(() => {})
            return Response.json({ error: "Uploaded file is empty (0 bytes)." }, { status: 400 })
        }

        if (obj.size > MAX_FILE_SIZE) {
            await r2.delete(r2Key).catch(() => {})
            return Response.json(
                {
                    error: `File size exceeds the 10 MB limit (${(obj.size / (1024 * 1024)).toFixed(1)} MB)`,
                },
                { status: 413 }
            )
        }

        const contentType =
            mime ||
            obj.httpMetadata?.contentType ||
            (isPdf ? "application/pdf" : "application/octet-stream")

        // PDF signature (magic bytes) validation
        if (isPdf) {
            try {
                const reader = obj.body.getReader()
                const { value } = await reader.read()
                reader.releaseLock()

                if (!value || value.length < 5) {
                    await r2.delete(r2Key).catch(() => {})
                    return Response.json(
                        { error: "File is too short to be a valid PDF document." },
                        { status: 400 }
                    )
                }

                // Check magic bytes "%PDF-" (0x25 0x50 0x44 0x46 0x2D)
                const isMagicMatch =
                    value[0] === 0x25 &&
                    value[1] === 0x50 &&
                    value[2] === 0x44 &&
                    value[3] === 0x46 &&
                    value[4] === 0x2d

                if (!isMagicMatch) {
                    await r2.delete(r2Key).catch(() => {})
                    return Response.json(
                        {
                            error: `File "${docName}" has a .pdf extension but is not a valid PDF document (missing %PDF- signature).`,
                        },
                        { status: 400 }
                    )
                }
            } catch (readErr) {
                console.warn("Could not read magic bytes from R2 object stream:", readErr)
            }
        }

        // Idempotency check: if document already recorded in D1, avoid conflicting duplicate workflow runs
        const existing = await getDocument(documentId).catch(() => null)
        if (existing) {
            return Response.json({
                document: existing,
                isPdf,
                progressUrl: isPdf ? `/api/files/${documentId}/progress` : undefined,
            } satisfies UploadCompleteResponse)
        }

        const appEnv = env as unknown as AppEnv

        if (isPdf) {
            // Record document in D1 as queued before starting Workflow
            try {
                await createDocument({
                    id: documentId,
                    conversation_id: conversationId,
                    name: docName,
                    r2_key: r2Key,
                    mime: contentType,
                    size: obj.size,
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
                            message: `Uploaded "${docName}". Starting background processing pipeline.`,
                            timestamp: Date.now(),
                        })
                    }
                } catch (doErr) {
                    console.warn("Could not seed DO state:", doErr)
                }
            }

            // Start Cloudflare Workflow with small serializable parameters
            if (appEnv.PDF_WORKFLOW) {
                try {
                    await appEnv.PDF_WORKFLOW.create({
                        id: documentId,
                        params: {
                            documentId,
                            r2Key,
                            fileName: docName,
                            conversationId,
                        },
                    })
                } catch (wfErr: unknown) {
                    console.error("Failed to trigger PDF_WORKFLOW:", wfErr)
                    // Mark D1 as failed to avoid permanent stuck queued record
                    await failDocument(
                        documentId,
                        "Failed to trigger background processing workflow",
                        "upload"
                    ).catch(() => {})
                    throw wfErr
                }
            } else {
                console.warn(
                    "PDF_WORKFLOW binding is not available in current environment. Background processing queued."
                )
            }

            const docItem = {
                id: documentId,
                conversation_id: conversationId,
                name: docName,
                r2_key: r2Key,
                mime: contentType,
                size: obj.size,
                status: "queued" as const,
                stage: "upload" as const,
                progress: 0,
                created_at: Date.now(),
            }

            return Response.json({
                document: docItem,
                isPdf: true,
                progressUrl: `/api/files/${documentId}/progress`,
            } satisfies UploadCompleteResponse)
        }

        // Non-PDF (images / plain text) handling
        const status: DocumentStatus = isImage ? "image" : "ready"

        try {
            await createDocument({
                id: documentId,
                conversation_id: conversationId,
                name: docName,
                r2_key: r2Key,
                mime: contentType,
                size: obj.size,
                status,
                stage: "ready",
                progress: 100,
                created_at: Date.now(),
            })
        } catch (dbErr: unknown) {
            const msg = dbErr instanceof Error ? dbErr.message : String(dbErr)
            console.warn("D1 could not record document:", msg)
        }

        const docItem: DocumentItem = {
            id: documentId,
            conversation_id: conversationId,
            name: docName,
            r2_key: r2Key,
            mime: contentType,
            size: obj.size,
            status,
            stage: "ready",
            progress: 100,
            created_at: Date.now(),
        }

        return Response.json({
            document: docItem,
            isPdf: false,
        } satisfies UploadCompleteResponse)
    } catch (err: unknown) {
        console.error("Error in POST /api/upload/complete:", err)
        const msg = err instanceof Error ? err.message : "Upload completion failed"
        return Response.json({ error: msg }, { status: 500 })
    }
}
