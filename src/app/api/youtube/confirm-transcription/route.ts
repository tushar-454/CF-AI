import { env } from "cloudflare:workers"
import { z } from "zod"
import { verifyPin } from "@/lib/auth"
import { getYoutubeVideo, updateYoutubeVideoProgress } from "@/lib/db"
import type { AppEnv, YoutubeConfirmationRequest } from "@/lib/types"
import { executeYoutubePipeline } from "@/lib/youtube-pipeline"

const ConfirmationSchema = z.object({
    videoId: z.string().min(5).max(30),
    confirmed: z.boolean(),
})

export async function POST(req: Request) {
    try {
        const pin = req.headers.get("x-app-pin")
        if (!verifyPin(pin, req)) {
            return Response.json(
                { error: "Unauthorized. Please enter the correct 4-digit security PIN." },
                { status: 401 }
            )
        }

        const body = (await req.json().catch(() => ({}))) as YoutubeConfirmationRequest
        const parsed = ConfirmationSchema.safeParse(body)
        if (!parsed.success) {
            return Response.json(
                { error: "Invalid payload", details: parsed.error.format() },
                { status: 400 }
            )
        }

        const { videoId, confirmed } = parsed.data
        const appEnv = env as unknown as AppEnv
        const video = await getYoutubeVideo(videoId, appEnv.DB)

        if (!video) {
            return Response.json({ error: "Video record not found" }, { status: 404 })
        }

        // Server-side verification: Must be currently awaiting explicit confirmation
        if (video.status !== "awaiting_confirmation") {
            return Response.json(
                {
                    error: `Video is not currently awaiting transcription confirmation (current status: ${video.status}).`,
                    status: video.status,
                },
                { status: 409 }
            )
        }

        if (!confirmed) {
            await updateYoutubeVideoProgress(
                videoId,
                {
                    status: "failed",
                    stage: "failed",
                    error_message: "AI transcription declined by user.",
                    completed_at: Date.now(),
                },
                appEnv.DB
            )
            return Response.json({
                success: true,
                videoId,
                status: "failed",
                message: "Transcription cancelled.",
            })
        }

        // User confirmed: Update status to extracting and launch workflow with forceAiTranscription = true
        await updateYoutubeVideoProgress(
            videoId,
            {
                status: "extracting",
                stage: "extracting",
                progress: 30,
                error_message: null,
            },
            appEnv.DB
        )

        const workflowParams = {
            videoId,
            url: video.url,
            title: video.title,
            forceAiTranscription: true,
        }

        if (appEnv.YOUTUBE_WORKFLOW) {
            try {
                await appEnv.YOUTUBE_WORKFLOW.create({
                    id: `${videoId}-confirmed-${Date.now()}`,
                    params: workflowParams,
                })
            } catch (wfErr) {
                console.warn(`[Workflow Confirm] Failed to spawn workflow for ${videoId}:`, wfErr)
            }
        } else {
            // Direct asynchronous fallback
            void executeYoutubePipeline(appEnv, workflowParams).catch((err) =>
                console.error(`[Direct Confirm Error] ${videoId}:`, err)
            )
        }

        return Response.json({
            success: true,
            videoId,
            status: "extracting",
            message: "AI transcription confirmed and initiated.",
        })
    } catch (error: unknown) {
        console.error("Error in POST /api/youtube/confirm-transcription:", error)
        const msg = error instanceof Error ? error.message : "Failed to confirm transcription"
        return Response.json({ error: msg }, { status: 500 })
    }
}
