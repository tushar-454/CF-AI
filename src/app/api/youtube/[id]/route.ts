import { env } from "cloudflare:workers"
import { verifyPin } from "@/lib/auth"
import { getYoutubeChunks, getYoutubeVideo } from "@/lib/db"
import type { AppEnv, TranscriptSegment } from "@/lib/types"
import { getYoutubeTranscriptFromR2 } from "@/lib/youtube-rag"

export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
    try {
        const pin = req.headers.get("x-app-pin")
        if (!verifyPin(pin, req)) {
            return Response.json(
                { error: "Unauthorized. Please enter the correct 4-digit security PIN." },
                { status: 401 }
            )
        }

        const { id: videoId } = await context.params
        if (!videoId || videoId.length < 5) {
            return Response.json({ error: "Invalid video ID" }, { status: 400 })
        }

        const appEnv = env as unknown as AppEnv
        const video = await getYoutubeVideo(videoId, appEnv.DB)

        if (!video) {
            return Response.json({ error: "YouTube video record not found" }, { status: 404 })
        }

        let segments: TranscriptSegment[] = []

        // Try reading full transcript from R2
        if (appEnv.FILES) {
            const transcript = await getYoutubeTranscriptFromR2(appEnv.FILES, videoId)
            if (transcript?.segments) {
                segments = transcript.segments
            }
        }

        // Fallback: reconstruct segments from chunks if full transcript file not present
        if (segments.length === 0) {
            const chunks = await getYoutubeChunks(videoId, appEnv.DB)
            segments = chunks.map((c) => ({
                id: c.id,
                startSeconds: c.startSeconds,
                endSeconds: c.endSeconds,
                text: c.text,
            }))
        }

        return Response.json({
            video,
            segments,
        })
    } catch (error: unknown) {
        console.error("Error in GET /api/youtube/[id]:", error)
        const msg = error instanceof Error ? error.message : "Failed to load video details"
        return Response.json({ error: msg }, { status: 500 })
    }
}
