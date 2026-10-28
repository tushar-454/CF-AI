import { env } from "cloudflare:workers"
import { verifyPin } from "@/lib/auth"
import { getDocument } from "@/lib/db"
import type { AppEnv } from "@/lib/types"

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
    const { id: documentId } = await params

    const requestUrl = new URL(req.url, "http://localhost")
    const pin =
        req.headers.get("x-app-pin") ||
        requestUrl.searchParams.get("pin") ||
        requestUrl.searchParams.get("token")

    if (!verifyPin(pin, req)) {
        return Response.json(
            { error: "Unauthorized. Please enter the correct 4-digit security PIN." },
            { status: 401 }
        )
    }

    const appEnv = env as unknown as AppEnv

    // Always verify that the document exists in D1 before allocating or contacting a Durable Object
    const doc = await getDocument(documentId, appEnv?.DB).catch(() => null)
    if (!doc) {
        return Response.json({ error: "Document not found" }, { status: 404 })
    }

    if (!appEnv?.DOCUMENT_PROGRESS_DO) {
        // Fallback snapshot if Durable Object binding is not configured in current environment
        const event = {
            documentId,
            status: doc.status,
            stage: doc.stage || (doc.status === "ready" ? "ready" : "upload"),
            progress: doc.progress ?? (doc.status === "ready" ? 100 : 0),
            error: doc.error_message || undefined,
            completedAt: doc.completed_at || undefined,
            timestamp: Date.now(),
        }
        return new Response(
            `id: 1\nevent: ${doc.status === "ready" ? "ready" : doc.status === "failed" ? "failed" : "progress"}\ndata: ${JSON.stringify(event)}\n\n`,
            {
                headers: {
                    "Content-Type": "text/event-stream; charset=utf-8",
                    "Cache-Control": "no-cache, no-transform",
                    Connection: "keep-alive",
                    "X-Accel-Buffering": "no",
                },
            }
        )
    }

    try {
        const doId = appEnv.DOCUMENT_PROGRESS_DO.idFromName(documentId)
        const stub = appEnv.DOCUMENT_PROGRESS_DO.get(doId)
        const internalUrl = `https://internal/files/${encodeURIComponent(documentId)}/progress`
        const doRequest = new Request(internalUrl, {
            method: "GET",
            headers: req.headers,
            signal: req.signal,
        })
        return await stub.fetch(doRequest)
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Failed to connect to Durable Object"
        console.error(`[DO SSE Error] Document ${documentId}:`, err)
        return Response.json({ error: msg }, { status: 500 })
    }
}
