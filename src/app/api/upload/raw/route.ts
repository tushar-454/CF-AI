import { verifyPin } from "@/lib/auth"
import { getR2 } from "@/lib/ai"
import { isPdfFile } from "@/lib/pdf"

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function PUT(req: Request) {
    return handleRawStreamUpload(req)
}

export async function POST(req: Request) {
    return handleRawStreamUpload(req)
}

async function handleRawStreamUpload(req: Request) {
    try {
        if (!verifyPin(req)) {
            return Response.json(
                { error: "Unauthorized. Please enter the correct 4-digit security PIN." },
                { status: 401 }
            )
        }

        const url = new URL(req.url)
        const documentId = url.searchParams.get("documentId")
        const filename = url.searchParams.get("filename") || "document.bin"
        const mime = url.searchParams.get("mime") || "application/octet-stream"
        const conversationId = url.searchParams.get("conversationId") || ""

        if (!documentId || !UUID_REGEX.test(documentId)) {
            return Response.json(
                { error: "Invalid or missing documentId parameter." },
                { status: 400 }
            )
        }

        if (!req.body) {
            return Response.json(
                { error: "No request body provided for upload stream." },
                { status: 400 }
            )
        }

        const ext = filename.split(".").pop()?.toLowerCase() || "bin"
        const r2Key = `uploads/${documentId}.${ext}`
        const isPdf = isPdfFile(mime, filename)
        const contentType = mime || (isPdf ? "application/pdf" : "application/octet-stream")

        const r2 = getR2()
        // Stream directly from request body into R2 without whole-file memory buffering
        await r2.put(r2Key, req.body, {
            httpMetadata: {
                contentType,
            },
            customMetadata: {
                originalName: filename,
                documentId,
                conversationId,
            },
        })

        return Response.json({ success: true, documentId, r2Key })
    } catch (err: unknown) {
        console.error("Error in streaming upload to R2:", err)
        const msg = err instanceof Error ? err.message : "Streaming upload to R2 failed"
        return Response.json({ error: msg }, { status: 500 })
    }
}
