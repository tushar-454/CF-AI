import { listDocuments, getDocument, deleteDocuments } from "@/lib/db"
import { getR2 } from "@/lib/ai"
import { deleteDocumentVectors } from "@/lib/rag"
import { env } from "cloudflare:workers"
import { verifyPin } from "@/lib/auth"
import { AppEnv } from "@/lib/types"

export async function GET(req: Request) {
    try {
        const pin = req.headers.get("x-app-pin")
        if (!verifyPin(pin, req)) {
            return Response.json(
                { error: "Unauthorized. Please enter the correct 4-digit security PIN." },
                { status: 401 }
            )
        }

        const url = new URL(req.url)
        const conversationId = url.searchParams.get("conversationId")
        const scope = url.searchParams.get("scope")

        let docs
        if (scope === "global") {
            docs = await listDocuments(null)
        } else if (conversationId) {
            docs = await listDocuments(conversationId)
        } else {
            docs = await listDocuments()
        }

        return Response.json(docs)
    } catch (error: unknown) {
        console.error("Error in GET /api/files:", error)
        const isBindingError = error instanceof Error && error.name === "DatabaseBindingError"
        const msg = error instanceof Error ? error.message : "Failed to list documents"
        return Response.json({ error: msg, isBindingError }, { status: isBindingError ? 503 : 500 })
    }
}

export async function DELETE(req: Request) {
    try {
        const pin = req.headers.get("x-app-pin")
        if (!verifyPin(pin, req)) {
            return Response.json(
                { error: "Unauthorized. Please enter the correct 4-digit security PIN." },
                { status: 401 }
            )
        }

        const body = (await req.json().catch(() => ({}))) as { ids?: string[]; id?: string }
        const ids: string[] = Array.isArray(body?.ids)
            ? body.ids.filter(Boolean)
            : body?.id
              ? [body.id]
              : []

        if (ids.length === 0) {
            return Response.json({ error: "No document IDs provided to delete" }, { status: 400 })
        }

        const r2 = getR2()
        const appEnv = env as unknown as AppEnv
        const vectorize = appEnv.VECTORIZE

        for (const id of ids) {
            // 1. Delete from R2
            try {
                const doc = await getDocument(id).catch(() => null)
                const r2Key = doc?.r2_key || `uploads/${id}`
                await r2.delete(r2Key)
            } catch (r2Err) {
                console.warn(`Could not delete file ${id} from R2:`, r2Err)
            }

            // 2. Delete vectors from Vectorize
            try {
                if (vectorize) {
                    await deleteDocumentVectors(vectorize, id)
                }
            } catch (vecErr) {
                console.warn(`Could not delete vectors for file ${id} from Vectorize:`, vecErr)
            }
        }

        // 3. Delete from D1
        await deleteDocuments(ids)

        return Response.json({
            success: true,
            count: ids.length,
            deletedIds: ids,
        })
    } catch (error: unknown) {
        console.error("Error in DELETE /api/files:", error)
        const isBindingError =
            error instanceof Error &&
            (error.name === "DatabaseBindingError" || error.name === "R2BindingError")
        const msg = error instanceof Error ? error.message : "Failed to delete files"
        return Response.json({ error: msg, isBindingError }, { status: isBindingError ? 503 : 500 })
    }
}
