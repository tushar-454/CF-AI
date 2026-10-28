import { deleteDocument, getDocument } from "@/lib/db"
import { getR2 } from "@/lib/ai"
import { deleteDocumentVectors } from "@/lib/rag"
import { env } from "cloudflare:workers"
import { verifyPin } from "@/lib/auth"
import { AppEnv } from "@/lib/types"

function inferMime(filename: string): string {
    const ext = filename.split(".").pop()?.toLowerCase()
    switch (ext) {
        case "png":
            return "image/png"
        case "jpg":
        case "jpeg":
            return "image/jpeg"
        case "gif":
            return "image/gif"
        case "webp":
            return "image/webp"
        case "svg":
            return "image/svg+xml"
        case "pdf":
            return "application/pdf"
        default:
            return "application/octet-stream"
    }
}

export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
    try {
        const { id } = await context.params
        const doc = await getDocument(id).catch(() => null)
        const r2 = getR2()

        let r2Key = doc?.r2_key
        let object = null

        if (r2Key) {
            object = await r2.get(r2Key)
        }

        if (!object) {
            object = await r2.get(`uploads/${id}`)
        }

        if (!object) {
            object = await r2.get(id)
        }

        if (!object) {
            try {
                const list = await r2.list({ prefix: `uploads/${id}`, limit: 1 })
                if (list.objects.length > 0) {
                    r2Key = list.objects[0].key
                    object = await r2.get(r2Key)
                }
            } catch {
                // ignore
            }
        }

        if (!object) {
            return Response.json({ error: "File not found in storage" }, { status: 404 })
        }

        const filename = doc?.name || r2Key?.split("/").pop() || id
        const contentType = doc?.mime || object.httpMetadata?.contentType || inferMime(filename)

        const headers = new Headers()
        headers.set("Content-Type", contentType)
        if (object.size) {
            headers.set("Content-Length", object.size.toString())
        }
        headers.set("Content-Disposition", `inline; filename="${encodeURIComponent(filename)}"`)
        headers.set("Cache-Control", "public, max-age=31536000, immutable")

        return new Response(object.body, { headers })
    } catch (error: unknown) {
        console.error("Error in GET /api/files/[id]:", error)
        const isBindingError = error instanceof Error && error.name === "R2BindingError"
        const msg = error instanceof Error ? error.message : "Failed to retrieve file"
        return Response.json({ error: msg, isBindingError }, { status: isBindingError ? 503 : 500 })
    }
}

export async function DELETE(req: Request, context: { params: Promise<{ id: string }> }) {
    try {
        const pin = req.headers.get("x-app-pin")
        if (!verifyPin(pin, req)) {
            return Response.json(
                { error: "Unauthorized. Please enter the correct 4-digit security PIN." },
                { status: 401 }
            )
        }

        const { id } = await context.params
        const doc = await getDocument(id)

        // 1. Delete from R2
        try {
            const r2 = getR2()
            const r2Key = doc?.r2_key || `uploads/${id}`
            await r2.delete(r2Key)
        } catch (r2Err) {
            console.warn("Could not delete from R2:", r2Err)
        }

        // 2. Delete vectors from Vectorize
        try {
            const appEnv = env as unknown as AppEnv
            const vectorize = appEnv.VECTORIZE
            if (vectorize) {
                await deleteDocumentVectors(vectorize, id, doc?.chunk_count)
            }
        } catch (vecErr) {
            console.warn("Could not delete vectors from Vectorize:", vecErr)
        }

        // 3. Delete from D1
        await deleteDocument(id)

        return Response.json({ success: true, deletedId: id })
    } catch (error: unknown) {
        console.error("Error in DELETE /api/files/[id]:", error)
        const isBindingError =
            error instanceof Error &&
            (error.name === "DatabaseBindingError" || error.name === "R2BindingError")
        const msg = error instanceof Error ? error.message : "Failed to delete file"
        return Response.json({ error: msg, isBindingError }, { status: isBindingError ? 503 : 500 })
    }
}
