/**
 * Cloudflare Workflow for resilient background YouTube video processing and indexing.
 * Implements idempotent durable steps, bounded retries, concurrency deduplication, and
 * real-time SSE progress reporting via DocumentProgressDO.
 */

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers"
import {
    createYoutubeVideo,
    failYoutubeVideo,
    getYoutubeChunks,
    getYoutubeVideo,
    saveYoutubeChunks,
    updateYoutubeVideoProgress,
} from "./db"
import { SupadataError } from "./supadata"
import { extractYouTubeTranscript } from "./youtube-extractor"
import type { AppEnv, VectorizeIndexBinding } from "./types"
import { chunkTranscriptSegments } from "./youtube-chunker"
import { YOUTUBE_CHAT_CONFIG } from "./youtube-model-config"
import {
    indexYoutubeChunks,
    persistYoutubeR2Artifacts,
    verifyYoutubeIndexingComplete,
} from "./youtube-rag"
import type {
    YoutubeChunk,
    YoutubeProgressEvent,
    YoutubeVideoItem,
    YoutubeVideoStage,
    YoutubeVideoStatus,
} from "./youtube-types"
import { parseYouTubeUrl } from "./youtube-url"
import { detectYouTubeVideoLanguage } from "./youtube-metadata"
import {
    executeYoutubePipeline,
    publishVideoProgress,
    type YoutubeWorkflowParams,
} from "./youtube-pipeline"

export { executeYoutubePipeline, publishVideoProgress, type YoutubeWorkflowParams }

/**
 * Cloudflare Workflow entrypoint for YouTube Video Processing.
 * Executes resilient, durable steps using the runtime's native WorkflowStep primitives.
 */
export class YoutubeProcessingWorkflow extends WorkflowEntrypoint<AppEnv, YoutubeWorkflowParams> {
    async run(event: WorkflowEvent<YoutubeWorkflowParams>, step: WorkflowStep): Promise<void> {
        const { videoId, url, forceAiTranscription = false } = event.payload
        let currentStage: YoutubeVideoStage = "validating"
        let currentProgress = 5

        const report = async (
            stage: YoutubeVideoStage,
            progress: number,
            message?: string,
            extras?: Partial<YoutubeProgressEvent>
        ) => {
            currentStage = stage
            currentProgress = progress
            const status: YoutubeVideoStatus =
                stage === "ready"
                    ? "ready"
                    : stage === "failed"
                      ? "failed"
                      : stage === "awaiting_confirmation"
                        ? "awaiting_confirmation"
                        : "validating"

            await updateYoutubeVideoProgress(
                videoId,
                {
                    status,
                    stage,
                    progress,
                    error_message: null,
                },
                this.env.DB
            )

            const progressEvent: YoutubeProgressEvent = {
                videoId,
                status,
                stage,
                progress,
                message,
                timestamp: Date.now(),
                ...extras,
            }
            await publishVideoProgress(this.env, progressEvent)
        }

        try {
            // Step 1: Validate URL and check cache completeness
            const cacheCheck = await step.do("validate-and-check-cache", async () => {
                const parsed = parseYouTubeUrl(url)
                if (!parsed.isValid) {
                    throw new Error(`Invalid YouTube URL: ${parsed.error}`)
                }
                if (parsed.videoId !== videoId) {
                    throw new Error(
                        `URL video ID mismatch: expected ${videoId}, parsed ${parsed.videoId}`
                    )
                }

                await report("checking_cache", 10, "Checking existing video knowledge cache...")

                // Step 1.5: Detect authoritative video audio language and real title
                const detected = await detectYouTubeVideoLanguage(videoId).catch(() => null)
                const targetLang = detected?.baseLang || "en"
                const resolvedTitle =
                    event.payload.title || detected?.title || `YouTube Video (${videoId})`

                const isFullyIndexed = await verifyYoutubeIndexingComplete(
                    this.env,
                    videoId,
                    targetLang
                )
                if (isFullyIndexed) {
                    await report("ready", 100, "Reusing existing verified video knowledge index.")
                    return { isComplete: true, targetLang }
                }

                // Ensure video record exists in D1
                const existing = await getYoutubeVideo(videoId, this.env.DB)
                if (!existing) {
                    const now = Date.now()
                    const newRecord: YoutubeVideoItem = {
                        id: videoId,
                        title: resolvedTitle,
                        url: parsed.canonicalUrl,
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
                    await createYoutubeVideo(newRecord, this.env.DB)
                } else if (detected?.title && existing.title.startsWith("YouTube Video (")) {
                    await updateYoutubeVideoProgress(
                        videoId,
                        { title: detected.title },
                        this.env.DB
                    )
                }

                return { isComplete: false, targetLang }
            })

            if (cacheCheck.isComplete) {
                return
            }

            const workflowTargetLang = cacheCheck.targetLang || "en"

            // Step 2: Transcript retrieval (primary: extract-youtube, fallback: supadata native, confirmation: supadata AI)
            const transcriptResult = await step.do("extract-transcript", async () => {
                await report("extracting", 20, "Extracting captions from YouTube...")

                const extractionResult = await extractYouTubeTranscript(videoId, this.env, {
                    lang: workflowTargetLang,
                    forceAiTranscription,
                    transcriptApi: event.payload.transcriptApi,
                })

                if (extractionResult.needsConfirmation || !extractionResult.transcript) {
                    await report(
                        "awaiting_confirmation",
                        25,
                        extractionResult.message ||
                            "No native captions found. AI speech-to-text transcription is available with user confirmation.",
                        {
                            needsConfirmation: true,
                            diagnostic: extractionResult.diagnostic,
                        }
                    )
                    return { transcript: null, needsConfirmation: true }
                }

                if (extractionResult.diagnostic) {
                    await report(
                        "extracting",
                        30,
                        extractionResult.diagnostic.message,
                        { diagnostic: extractionResult.diagnostic }
                    )
                }

                return { transcript: extractionResult.transcript, needsConfirmation: false }
            })

            if (transcriptResult.needsConfirmation || !transcriptResult.transcript) {
                return
            }

            const normalizedTranscript = transcriptResult.transcript

            // Step 3: Chunking & artifact persistence
            const chunkMeta = await step.do("chunk-and-persist", async () => {
                await report("chunking", 50, "Generating semantic timestamped chunks...")

                const chunks = chunkTranscriptSegments(videoId, normalizedTranscript.segments)
                if (chunks.length === 0) {
                    throw new Error("Transcript contained no readable text to index.")
                }

                // Persist to D1
                await saveYoutubeChunks(videoId, chunks, this.env.DB)

                // Persist full artifacts to R2 if available
                if (this.env.FILES) {
                    await persistYoutubeR2Artifacts(
                        this.env.FILES,
                        videoId,
                        normalizedTranscript,
                        chunks
                    )
                }

                // Update video duration & metadata in D1
                await updateYoutubeVideoProgress(
                    videoId,
                    {
                        duration: normalizedTranscript.duration,
                        transcript_lang: normalizedTranscript.lang,
                        transcript_source: normalizedTranscript.source,
                        chunk_count: chunks.length,
                    },
                    this.env.DB
                )

                await report(
                    "embedding",
                    65,
                    `Generated ${chunks.length} transcript chunks. Computing embeddings...`,
                    { totalChunks: chunks.length }
                )

                return { totalChunks: chunks.length, chunks }
            })

            // Step 4: Batched embedding generation and Vectorize upsert
            await step.do(
                "index-vectors",
                {
                    retries: {
                        limit: YOUTUBE_CHAT_CONFIG.workflowMaxRetries,
                        delay: `${YOUTUBE_CHAT_CONFIG.workflowRetryDelaySeconds} seconds`,
                        backoff: "exponential",
                    },
                },
                async () => {
                    const ai = this.env.AI
                    const vectorize = this.env.VECTORIZE as VectorizeIndexBinding | undefined

                    if (!ai || !vectorize) {
                        console.warn(
                            "[YouTube Workflow] Vectorize or Workers AI binding missing. Stored chunks in D1/R2 for keyword RAG."
                        )
                        return { indexed: 0 }
                    }

                    await report(
                        "indexing",
                        80,
                        `Indexing ${chunkMeta.totalChunks} vectors into Vectorize...`,
                        {
                            totalChunks: chunkMeta.totalChunks,
                        }
                    )

                    let chunksToIndex: YoutubeChunk[] = chunkMeta.chunks
                    if (!chunksToIndex || chunksToIndex.length === 0) {
                        chunksToIndex = await getYoutubeChunks(videoId, this.env.DB)
                    }

                    const { chunksIndexed } = await indexYoutubeChunks(
                        ai,
                        vectorize,
                        videoId,
                        chunksToIndex
                    )

                    await report(
                        "indexing",
                        95,
                        `Indexed ${chunksIndexed} vector records. Finalizing video knowledge...`,
                        { chunksIndexed, totalChunks: chunksToIndex.length }
                    )

                    return { indexed: chunksIndexed }
                }
            )

            // Step 5: Mark ready & finalize
            await step.do("mark-ready", async () => {
                const now = Date.now()
                await updateYoutubeVideoProgress(
                    videoId,
                    {
                        status: "ready",
                        stage: "ready",
                        progress: 100,
                        completed_at: now,
                        error_message: null,
                    },
                    this.env.DB
                )

                await report("ready", 100, "Video is indexed and ready for grounded chat.", {
                    completedAt: now,
                    chunksIndexed: chunkMeta.totalChunks,
                    totalChunks: chunkMeta.totalChunks,
                })

                return { ready: true }
            })
        } catch (err: unknown) {
            const errorMsg =
                err instanceof SupadataError
                    ? err.message
                    : err instanceof Error
                      ? err.message
                      : "Video processing failed."

            console.error(
                `[YouTube Workflow Error] Video ${videoId} failed in stage ${currentStage}:`,
                err
            )

            await failYoutubeVideo(videoId, errorMsg, currentStage, this.env.DB).catch(() => {})

            const failEvent: YoutubeProgressEvent = {
                videoId,
                status: "failed",
                stage: "failed",
                progress: currentProgress,
                error: errorMsg,
                timestamp: Date.now(),
            }
            await publishVideoProgress(this.env, failEvent).catch(() => {})

            throw err
        }
    }
}
