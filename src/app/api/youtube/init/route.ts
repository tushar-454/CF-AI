import { env } from "cloudflare:workers"
import { z } from "zod"
import { verifyPin } from "@/lib/auth"
import { createYoutubeVideo, getYoutubeVideo, updateYoutubeVideoProgress } from "@/lib/db"
import type { AppEnv, YoutubeInitResponse } from "@/lib/types"
import { YOUTUBE_CHAT_CONFIG } from "@/lib/youtube-model-config"
import { verifyYoutubeIndexingComplete } from "@/lib/youtube-rag"
import { parseYouTubeUrl } from "@/lib/youtube-url"
import { executeYoutubePipeline } from "@/lib/youtube-pipeline"
import { detectYouTubeVideoLanguage } from "@/lib/youtube-metadata"

const InitSchema = z.object({
    url: z.string().min(1, "URL is required"),
    title: z.string().max(200).optional(),
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

        const body = await req.json().catch(() => ({}))
        const parsed = InitSchema.safeParse(body)
        if (!parsed.success) {
            return Response.json(
                { error: "Invalid payload", details: parsed.error.format() },
                { status: 400 }
            )
        }

        const urlValidation = parseYouTubeUrl(parsed.data.url)
        if (!urlValidation.isValid) {
            return Response.json({ error: urlValidation.error }, { status: 400 })
        }

        const { videoId, canonicalUrl } = urlValidation
        const appEnv = env as unknown as AppEnv

        // Detect video audio language and real metadata
        const detected = await detectYouTubeVideoLanguage(videoId).catch(() => null)
        const targetLang = detected?.baseLang || "en"
        const videoTitle = parsed.data.title || detected?.title || `YouTube Video (${videoId})`

        // Step 1: Check if already completely and compatibly indexed in the correct language
        const isIndexed = await verifyYoutubeIndexingComplete(appEnv, videoId, targetLang).catch(
            () => false
        )
        if (isIndexed) {
            const video = await getYoutubeVideo(videoId, appEnv.DB)
            const responsePayload: YoutubeInitResponse = {
                videoId,
                url: canonicalUrl,
                status: "ready",
                stage: "ready",
                progress: 100,
                isReady: true,
                video,
            }
            return Response.json(responsePayload)
        }

        // Step 2: Check current database record state
        let video = await getYoutubeVideo(videoId, appEnv.DB)

        if (video?.status === "awaiting_confirmation") {
            const responsePayload: YoutubeInitResponse = {
                videoId,
                url: canonicalUrl,
                status: "awaiting_confirmation",
                stage: "awaiting_confirmation",
                progress: video.progress || 25,
                isReady: false,
                needsConfirmation: true,
                video,
                message:
                    "Native YouTube captions are unavailable. Explicit confirmation is required for AI transcription.",
            }
            return Response.json(responsePayload)
        }

        // If newly created or restarting after failure:
        const now = Date.now()
        if (!video) {
            video = {
                id: videoId,
                title: videoTitle,
                url: canonicalUrl,
                duration: 0,
                transcript_version: 1,
                status: "validating",
                stage: "validating",
                progress: 10,
                embedding_model: YOUTUBE_CHAT_CONFIG.embeddingModelId,
                chunk_count: 0,
                created_at: now,
                updated_at: now,
            }
            await createYoutubeVideo(video, appEnv.DB)
        } else if (detected?.title && video.title.startsWith("YouTube Video (")) {
            await updateYoutubeVideoProgress(videoId, { title: detected.title }, appEnv.DB)
            video.title = detected.title
        } else if (video.status === "failed") {
            await updateYoutubeVideoProgress(
                videoId,
                {
                    status: "validating",
                    stage: "validating",
                    progress: 10,
                    error_message: null,
                },
                appEnv.DB
            )
        }

        // Step 3: Trigger background workflow or asynchronous pipeline
        const workflowParams = {
            videoId,
            url: canonicalUrl,
            title: video.title,
            forceAiTranscription: false,
        }

        if (appEnv.YOUTUBE_WORKFLOW) {
            try {
                await appEnv.YOUTUBE_WORKFLOW.create({
                    id: `${videoId}-${Date.now()}`,
                    params: workflowParams,
                })
            } catch (wfErr) {
                console.warn(`[Workflow Init] Failed to spawn workflow for ${videoId}:`, wfErr)
            }
        } else {
            // Asynchronous direct execution fallback for environments without workflow bindings
            void executeYoutubePipeline(appEnv, workflowParams).catch((err) =>
                console.error(`[Direct Pipeline Error] ${videoId}:`, err)
            )
        }

        const responsePayload: YoutubeInitResponse = {
            videoId,
            url: canonicalUrl,
            status: "validating",
            stage: "validating",
            progress: 10,
            isReady: false,
            video,
        }

        return Response.json(responsePayload)
    } catch (error: unknown) {
        console.error("Error in POST /api/youtube/init:", error)
        const msg = error instanceof Error ? error.message : "Failed to initialize YouTube video"
        return Response.json({ error: msg }, { status: 500 })
    }
}
