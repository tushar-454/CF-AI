import { env } from "cloudflare:workers"
import { verifyPin } from "@/lib/auth"
import { getYoutubeVideo } from "@/lib/db"
import { SSE_HEADERS } from "@/lib/sse"
import type { AppEnv, YoutubeProgressEvent } from "@/lib/types"

export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
    const { id: videoId } = await context.params

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
    const video = await getYoutubeVideo(videoId, appEnv?.DB).catch(() => null)
    if (!video) {
        return Response.json({ error: "Video record not found" }, { status: 404 })
    }

    if (!appEnv?.DOCUMENT_PROGRESS_DO) {
        // Fallback snapshot if Durable Object binding is not configured in current environment
        const event: YoutubeProgressEvent = {
            videoId,
            status: video.status,
            stage: video.stage || (video.status === "ready" ? "ready" : "validating"),
            progress: video.progress ?? (video.status === "ready" ? 100 : 0),
            error: video.error_message || undefined,
            completedAt: video.completed_at || undefined,
            timestamp: Date.now(),
            totalChunks: video.chunk_count,
            chunksIndexed: video.chunk_count,
        }
        return new Response(
            `id: 1\nevent: ${video.status === "ready" ? "ready" : video.status === "failed" ? "failed" : "progress"}\ndata: ${JSON.stringify(event)}\n\n`,
            {
                headers: SSE_HEADERS,
            }
        )
    }

    try {
        const doId = appEnv.DOCUMENT_PROGRESS_DO.idFromName(videoId)
        const stub = appEnv.DOCUMENT_PROGRESS_DO.get(doId)
        const internalUrl = `https://internal/youtube/${encodeURIComponent(videoId)}/progress`
        const doRequest = new Request(internalUrl, {
            method: "GET",
            headers: req.headers,
            signal: req.signal,
        })
        return await stub.fetch(doRequest)
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Failed to connect to Durable Object"
        console.error(`[DO SSE Error] YouTube Video ${videoId}:`, err)
        return Response.json({ error: msg }, { status: 500 })
    }
}
