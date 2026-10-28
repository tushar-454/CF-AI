import { env } from "cloudflare:workers"
import { verifyPin } from "@/lib/auth"
import { createR2PresignedPutUrl } from "@/lib/r2-presign"
import { isPdfFile } from "@/lib/pdf"
import { AppEnv, UploadInitRequest, UploadInitResponse } from "@/lib/types"

const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10 MB

export async function POST(req: Request) {
    try {
        if (!verifyPin(req)) {
            return Response.json(
                { error: "Unauthorized. Please enter the correct 4-digit security PIN." },
                { status: 401 }
            )
        }

        const body = (await req.json().catch(() => ({}))) as Partial<UploadInitRequest>
        const { filename, mime = "", size, conversationId } = body

        if (!filename || typeof filename !== "string" || !filename.trim()) {
            return Response.json(
                { error: "Invalid upload request: filename is required." },
                { status: 400 }
            )
        }

        if (typeof size !== "number" || size <= 0) {
            return Response.json(
                { error: "Invalid upload request: file size must be greater than 0." },
                { status: 400 }
            )
        }

        if (size > MAX_FILE_SIZE) {
            return Response.json(
                {
                    error: `File size exceeds the 10 MB limit (${(size / (1024 * 1024)).toFixed(1)} MB)`,
                },
                { status: 413 }
            )
        }

        const documentId = crypto.randomUUID()
        const ext = filename.split(".").pop()?.toLowerCase() || "bin"
        const r2Key = `uploads/${documentId}.${ext}`
        const isPdf = isPdfFile(mime, filename)
        const contentType = mime || (isPdf ? "application/pdf" : "application/octet-stream")

        const appEnv = env as unknown as AppEnv
        const accessKeyId = appEnv.R2_ACCESS_KEY_ID
        const secretAccessKey = appEnv.R2_SECRET_ACCESS_KEY
        const bucketName = appEnv.R2_BUCKET || "chatbot-files"
        const accountId = appEnv.CLOUDFLARE_ACCOUNT_ID
        const endpoint = appEnv.R2_ENDPOINT

        // Check if R2 S3 credentials are configured for direct presigned upload
        if (accessKeyId && secretAccessKey && (accountId || endpoint)) {
            try {
                const uploadUrl = await createR2PresignedPutUrl({
                    endpoint,
                    accountId,
                    bucketName,
                    objectKey: r2Key,
                    accessKeyId,
                    secretAccessKey,
                    contentType,
                    expiresInSeconds: 900,
                })

                const responseData: UploadInitResponse = {
                    mode: "presigned",
                    documentId,
                    r2Key,
                    uploadUrl,
                    headers: {
                        "Content-Type": contentType,
                    },
                    maxSizeBytes: MAX_FILE_SIZE,
                }
                return Response.json(responseData)
            } catch (presignErr) {
                console.warn(
                    "Presigned URL generation failed, falling back to streaming endpoint:",
                    presignErr
                )
            }
        }

        // Direct streaming fallback (streams raw request body without whole-file memory buffering)
        const urlObj = new URL(req.url)
        const rawUploadUrl = `${urlObj.origin}/api/upload/raw?documentId=${encodeURIComponent(documentId)}&filename=${encodeURIComponent(filename)}&mime=${encodeURIComponent(contentType)}${conversationId ? `&conversationId=${encodeURIComponent(conversationId)}` : ""}`

        const responseData: UploadInitResponse = {
            mode: "stream",
            documentId,
            r2Key,
            uploadUrl: rawUploadUrl,
            headers: {
                "Content-Type": contentType,
            },
            maxSizeBytes: MAX_FILE_SIZE,
        }
        return Response.json(responseData)
    } catch (err: unknown) {
        console.error("Error in POST /api/upload/init:", err)
        const msg = err instanceof Error ? err.message : "Failed to initialize upload"
        return Response.json({ error: msg }, { status: 500 })
    }
}
