/**
 * Primary YouTube caption extractor using `extract-youtube` with deterministic
 * fallback to Supadata native captions and explicit user-confirmed AI transcription.
 * Fully instrumented with structured diagnostics and failure classification.
 */

import {
    YouTubeTranscriptApi,
    type FetchedTranscriptSnippet,
    type HttpClient,
    type TranscriptList,
    type Transcript,
} from "extract-youtube"
import {
    fetchNativeCaptions,
    startAiTranscription,
    pollAiTranscriptionJob,
    SupadataError,
} from "./supadata"
import type { AppEnv } from "./types"
import type {
    NormalizedTranscript,
    TranscriptSegment,
    YoutubeDiagnosticEvent,
} from "./youtube-types"
import { YOUTUBE_CHAT_CONFIG } from "./youtube-model-config"
import {
    classifyYoutubeError,
    detectExecutionRuntime,
    generateCorrelationId,
    isRetryableFailureCategory,
    logDiagnostic,
    validateTranscriptSnippets,
    type YoutubeFailureCategory,
} from "./youtube-diagnostics"

export interface ExtractYoutubeOptions {
    lang?: string
    signal?: AbortSignal
    timeoutMs?: number
    requestId?: string
    attempt?: number
    disableFallback?: boolean
    playerResponse?: {
        playabilityStatus?: string
        playabilityReason?: string
    }
    transcriptApi?: {
        listTranscripts(videoId: string): Promise<TranscriptList | Iterable<Transcript>>
    }
}

export type ExtractYoutubeFailureReason =
    | YoutubeFailureCategory
    | "no_captions"
    | "blocked"
    | "video_unavailable"
    | "network_error"
    | "timeout"
    | "malformed"
    | "error"

export type ExtractYoutubeResult =
    | {
          found: true
          transcript: NormalizedTranscript
          isGenerated: boolean
          languageCode: string
          provider: "extract-youtube"
          requestId: string
      }
    | {
          found: false
          reason: ExtractYoutubeFailureReason
          failureCategory: YoutubeFailureCategory
          message: string
          isRetryable: boolean
          error?: unknown
          requestId: string
          httpStatus?: number
          playabilityStatus?: string
          playabilityReason?: string
      }

export type ExtractTranscriptPipelineResult =
    | {
          transcript: NormalizedTranscript
          provider: "extract-youtube" | "supadata" | "supadata-ai"
          needsConfirmation: false
          diagnostic?: YoutubeDiagnosticEvent
      }
    | {
          transcript: null
          provider: null
          needsConfirmation: true
          message: string
          diagnostic?: YoutubeDiagnosticEvent
      }

/**
 * Creates an instrumented fetch-based HTTP client for Cloudflare Workers and standard environments.
 * Observes underlying requests and responses (`extract_youtube.request_started` and
 * `extract_youtube.response_received`) with accurate timing and status codes.
 */
export function createWorkersHttpClient(
    signal?: AbortSignal,
    timeoutMs: number = 8000,
    context?: {
        requestId?: string
        videoId?: string
        attempt?: number
        playerResponse?: {
            playabilityStatus?: string
            playabilityReason?: string
        }
    }
): HttpClient {
    const requestId = context?.requestId || generateCorrelationId()
    const videoId = context?.videoId
    const attempt = context?.attempt || 1
    const runtime = detectExecutionRuntime()

    const makeRequest = async (
        method: "GET" | "POST",
        url: string,
        options?: RequestInit
    ): Promise<Response> => {
        logDiagnostic({
            event: "extract_youtube.request_started",
            requestId,
            videoId,
            provider: "extract-youtube",
            attempt,
            runtime,
            urlTarget: url,
        })

        const startTime = Date.now()
        const timeoutSignal = AbortSignal.timeout(timeoutMs)
        const combinedSignal = signal
            ? AbortSignal.any([signal, timeoutSignal, ...(options?.signal ? [options.signal] : [])])
            : (options?.signal ? AbortSignal.any([timeoutSignal, options.signal]) : timeoutSignal)

        const res = await fetch(url, {
            ...options,
            method,
            signal: combinedSignal,
            headers: {
                "User-Agent":
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                "Accept-Language": "en-US,en;q=0.9",
                ...(options?.headers as Record<string, string>),
            },
        })

        const durationMs = Date.now() - startTime

        // Targeted diagnostics: inspect /youtubei/v1/player playabilityStatus on response
        if (url.includes("/youtubei/v1/player")) {
            try {
                const cloned = res.clone()
                const data = (await cloned.json()) as {
                    playabilityStatus?: {
                        status?: string
                        reason?: string
                        messages?: string[]
                        errorScreen?: {
                            playerErrorMessageRenderer?: {
                                reason?: { runs?: Array<{ text?: string }> }
                                subreason?: { runs?: Array<{ text?: string }> }
                            }
                        }
                    }
                }
                if (data?.playabilityStatus && context) {
                    if (!context.playerResponse) {
                        context.playerResponse = {}
                    }
                    const status = data.playabilityStatus.status
                    const reason =
                        data.playabilityStatus.reason ||
                        (Array.isArray(data.playabilityStatus.messages)
                            ? data.playabilityStatus.messages[0]
                            : undefined) ||
                        data.playabilityStatus.errorScreen?.playerErrorMessageRenderer?.reason?.runs
                            ?.map((r) => r.text)
                            .filter(Boolean)
                            .join("") ||
                        data.playabilityStatus.errorScreen?.playerErrorMessageRenderer?.subreason?.runs
                            ?.map((r) => r.text)
                            .filter(Boolean)
                            .join("")

                    context.playerResponse.playabilityStatus = status
                    context.playerResponse.playabilityReason = reason
                }
            } catch {
                // Ignore clone parsing errors to preserve stream
            }
        }

        logDiagnostic({
            event: "extract_youtube.response_received",
            requestId,
            videoId,
            provider: "extract-youtube",
            attempt,
            runtime,
            durationMs,
            httpStatus: res.status,
            success: res.ok,
            urlTarget: url,
        })

        return res
    }

    return {
        get(url: string, options?: RequestInit): Promise<Response> {
            return makeRequest("GET", url, options)
        },
        post(url: string, options?: RequestInit): Promise<Response> {
            return makeRequest("POST", url, options)
        },
    }
}

/**
 * Normalizes raw snippets from `extract-youtube` (seconds) into canonical TranscriptSegments.
 */
export function normalizeExtractYoutubeSnippets(
    snippets: FetchedTranscriptSnippet[],
    videoId: string,
    lang: string = "en",
    version: number = 1
): NormalizedTranscript {
    const segments: TranscriptSegment[] = []
    let maxEndSeconds = 0

    for (let i = 0; i < snippets.length; i++) {
        const item = snippets[i]
        const text = (item.text || "").replace(/\s+/g, " ").trim()
        if (!text) continue

        const startSeconds = Math.max(0, Number(item.start || 0))
        const durationSeconds = Math.max(0.1, Number(item.duration || 0))
        const endSeconds = startSeconds + durationSeconds

        if (endSeconds > maxEndSeconds) {
            maxEndSeconds = endSeconds
        }

        segments.push({
            id: `seg_${i}`,
            startSeconds: Number(startSeconds.toFixed(2)),
            endSeconds: Number(endSeconds.toFixed(2)),
            text,
            lang,
        })
    }

    const fullText = segments.map((s) => s.text).join(" ")

    return {
        videoId,
        lang,
        source: "native",
        provider: "extract-youtube",
        segments,
        fullText,
        duration: Math.ceil(maxEndSeconds),
        version,
    }
}

/**
 * Prioritizes transcript tracks based on user/audio language and creator vs auto-generated status.
 */
export function selectBestTranscriptTrack<T extends { languageCode: string; isGenerated: boolean }>(
    tracks: T[],
    targetLang?: string
): T | null {
    if (!tracks || tracks.length === 0) return null

    const cleanLang = (targetLang || "").trim().toLowerCase()
    const baseLang = cleanLang.split("-")[0].split("_")[0]

    if (cleanLang) {
        // 1. Exact match manual
        const exactManual = tracks.find(
            (t) => !t.isGenerated && t.languageCode.toLowerCase() === cleanLang
        )
        if (exactManual) return exactManual

        // 2. Base match manual
        const baseManual = tracks.find(
            (t) =>
                !t.isGenerated &&
                (t.languageCode.toLowerCase() === baseLang ||
                    t.languageCode.toLowerCase().startsWith(`${baseLang}-`) ||
                    t.languageCode.toLowerCase().startsWith(`${baseLang}_`))
        )
        if (baseManual) return baseManual

        // 3. Exact match auto-generated
        const exactGen = tracks.find(
            (t) => t.isGenerated && t.languageCode.toLowerCase() === cleanLang
        )
        if (exactGen) return exactGen

        // 4. Base match auto-generated
        const baseGen = tracks.find(
            (t) =>
                t.isGenerated &&
                (t.languageCode.toLowerCase() === baseLang ||
                    t.languageCode.toLowerCase().startsWith(`${baseLang}-`) ||
                    t.languageCode.toLowerCase().startsWith(`${baseLang}_`))
        )
        if (baseGen) return baseGen
    }

    // 5. English manual
    const enManual = tracks.find(
        (t) => !t.isGenerated && t.languageCode.toLowerCase().startsWith("en")
    )
    if (enManual) return enManual

    // 6. English generated
    const enGen = tracks.find(
        (t) => t.isGenerated && t.languageCode.toLowerCase().startsWith("en")
    )
    if (enGen) return enGen

    // 7. First manual track in any language
    const anyManual = tracks.find((t) => !t.isGenerated)
    if (anyManual) return anyManual

    // 8. First available track
    return tracks[0] || null
}

/**
 * Attempts to retrieve existing platform captions using the primary provider `extract-youtube`.
 * Fully instrumented with structured diagnostics covering each step of extraction.
 */
export async function fetchCaptionsFromExtractYoutube(
    videoId: string,
    options: ExtractYoutubeOptions = {}
): Promise<ExtractYoutubeResult> {
    const requestId = options.requestId || generateCorrelationId()
    const runtime = detectExecutionRuntime()
    const attempt = options.attempt || 1

    logDiagnostic({
        event: "extract_youtube.started",
        requestId,
        videoId,
        provider: "extract-youtube",
        attempt,
        runtime,
    })

    if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
        logDiagnostic({
            event: "extract_youtube.failed",
            requestId,
            videoId,
            provider: "extract-youtube",
            attempt,
            runtime,
            success: false,
            failureCategory: "invalid_video_id",
            errorMessage: "Invalid YouTube video ID format.",
            durationMs: 0,
        })
        return {
            found: false,
            reason: "invalid_video_id",
            failureCategory: "invalid_video_id",
            message: "Invalid YouTube video ID format.",
            isRetryable: false,
            requestId,
        }
    }

    logDiagnostic({
        event: "extract_youtube.video_id_validated",
        requestId,
        videoId,
        provider: "extract-youtube",
        attempt,
        runtime,
    })

    const startTime = Date.now()
    const playerResponse = options.playerResponse || {}
    const context = {
        requestId,
        videoId,
        attempt,
        playerResponse,
    }

    try {
        const timeoutMs = options.timeoutMs || YOUTUBE_CHAT_CONFIG.requestTimeoutMs || 8000
        const httpClient = createWorkersHttpClient(options.signal, timeoutMs, context)
        const api = options.transcriptApi || new YouTubeTranscriptApi({ httpClient })

        const transcriptList = await api.listTranscripts(videoId)
        const allTracks: Transcript[] = Array.from(transcriptList)

        if (allTracks.length === 0) {
            const durationMs = Date.now() - startTime
            logDiagnostic({
                event: "extract_youtube.failed",
                requestId,
                videoId,
                provider: "extract-youtube",
                attempt,
                runtime,
                success: false,
                failureCategory: "captions_unavailable",
                errorMessage: "No caption tracks listed for this video.",
                durationMs,
                playabilityStatus: context.playerResponse?.playabilityStatus,
                playabilityReason: context.playerResponse?.playabilityReason,
            })
            return {
                found: false,
                reason: "captions_unavailable",
                failureCategory: "captions_unavailable",
                message: "No caption tracks listed for this video.",
                isRetryable: false,
                requestId,
                playabilityStatus: context.playerResponse?.playabilityStatus,
                playabilityReason: context.playerResponse?.playabilityReason,
            }
        }

        const selectedTrack = selectBestTranscriptTrack(allTracks, options.lang)
        if (!selectedTrack) {
            const durationMs = Date.now() - startTime
            logDiagnostic({
                event: "extract_youtube.failed",
                requestId,
                videoId,
                provider: "extract-youtube",
                attempt,
                runtime,
                success: false,
                failureCategory: "captions_unavailable",
                errorMessage: "No suitable caption track found.",
                durationMs,
                playabilityStatus: context.playerResponse?.playabilityStatus,
                playabilityReason: context.playerResponse?.playabilityReason,
            })
            return {
                found: false,
                reason: "captions_unavailable",
                failureCategory: "captions_unavailable",
                message: "No suitable caption track found.",
                isRetryable: false,
                requestId,
                playabilityStatus: context.playerResponse?.playabilityStatus,
                playabilityReason: context.playerResponse?.playabilityReason,
            }
        }

        const fetched = await selectedTrack.fetch()

        // Validate snippet cue content and timestamps
        const validation = validateTranscriptSnippets(fetched?.snippets)
        if (!validation.valid) {
            const durationMs = Date.now() - startTime
            const category = validation.failureCategory || "empty_transcript"
            logDiagnostic({
                event: "extract_youtube.transcript_validation_failed",
                requestId,
                videoId,
                provider: "extract-youtube",
                attempt,
                runtime,
                failureCategory: category,
                errorMessage: validation.reason,
                captionCount: validation.count,
                durationMs,
            })
            logDiagnostic({
                event: "extract_youtube.failed",
                requestId,
                videoId,
                provider: "extract-youtube",
                attempt,
                runtime,
                success: false,
                failureCategory: category,
                errorMessage: validation.reason,
                durationMs,
                playabilityStatus: context.playerResponse?.playabilityStatus,
                playabilityReason: context.playerResponse?.playabilityReason,
            })
            return {
                found: false,
                reason: category,
                failureCategory: category,
                message: validation.reason || "Caption track contained no valid text cues.",
                isRetryable: false,
                requestId,
                playabilityStatus: context.playerResponse?.playabilityStatus,
                playabilityReason: context.playerResponse?.playabilityReason,
            }
        }

        const normalized = normalizeExtractYoutubeSnippets(
            fetched.snippets,
            videoId,
            fetched.languageCode || selectedTrack.languageCode || options.lang || "en"
        )

        if (normalized.segments.length === 0) {
            const durationMs = Date.now() - startTime
            logDiagnostic({
                event: "extract_youtube.transcript_validation_failed",
                requestId,
                videoId,
                provider: "extract-youtube",
                attempt,
                runtime,
                failureCategory: "empty_transcript",
                errorMessage: "Caption snippets contained no readable text.",
                captionCount: 0,
                durationMs,
            })
            logDiagnostic({
                event: "extract_youtube.failed",
                requestId,
                videoId,
                provider: "extract-youtube",
                attempt,
                runtime,
                success: false,
                failureCategory: "empty_transcript",
                errorMessage: "Caption snippets contained no readable text.",
                durationMs,
                playabilityStatus: context.playerResponse?.playabilityStatus,
                playabilityReason: context.playerResponse?.playabilityReason,
            })
            return {
                found: false,
                reason: "empty_transcript",
                failureCategory: "empty_transcript",
                message: "Caption snippets contained no readable text.",
                isRetryable: false,
                requestId,
                playabilityStatus: context.playerResponse?.playabilityStatus,
                playabilityReason: context.playerResponse?.playabilityReason,
            }
        }

        const durationMs = Date.now() - startTime

        logDiagnostic({
            event: "extract_youtube.transcript_received",
            requestId,
            videoId,
            provider: "extract-youtube",
            attempt,
            runtime,
            captionCount: normalized.segments.length,
            totalCharacters: normalized.fullText.length,
            language: normalized.lang,
            durationMs,
        })

        logDiagnostic({
            event: "extract_youtube.completed",
            requestId,
            videoId,
            provider: "extract-youtube",
            attempt,
            runtime,
            success: true,
            captionCount: normalized.segments.length,
            totalCharacters: normalized.fullText.length,
            language: normalized.lang,
            durationMs,
        })

        return {
            found: true,
            transcript: normalized,
            isGenerated: selectedTrack.isGenerated,
            languageCode: normalized.lang,
            provider: "extract-youtube",
            requestId,
        }
    } catch (err: unknown) {
        const durationMs = Date.now() - startTime
        const playabilityStatus = context.playerResponse?.playabilityStatus
        const playabilityReason = context.playerResponse?.playabilityReason
        const classified = classifyYoutubeError(err, {
            videoId,
            playabilityStatus,
            playabilityReason,
        })

        const finalStatus = classified.playabilityStatus || playabilityStatus
        const finalReason = classified.playabilityReason || playabilityReason

        logDiagnostic({
            event: "extract_youtube.failed",
            requestId,
            videoId,
            provider: "extract-youtube",
            attempt,
            runtime,
            success: false,
            errorName: classified.errorName,
            errorMessage: classified.message,
            errorCode: classified.errorCode,
            httpStatus: classified.httpStatus,
            errorCause: classified.errorCause,
            stack: classified.stack,
            failureCategory: classified.category,
            playabilityStatus: finalStatus,
            playabilityReason: finalReason,
            durationMs,
        })

        return {
            found: false,
            reason: classified.category,
            failureCategory: classified.category,
            message: classified.message,
            isRetryable: isRetryableFailureCategory(classified.category),
            error: err,
            requestId,
            httpStatus: classified.httpStatus,
            playabilityStatus: finalStatus,
            playabilityReason: finalReason,
        }
    }
}

/**
 * Central orchestrator for transcript extraction with deterministic priority:
 * 1. Primary: `extract-youtube` (free, direct, zero credentials).
 * 2. Secondary fallback: Supadata native captions (uses existing client & credentials).
 * 3. AI transcription: Only after explicit user confirmation (`forceAiTranscription === true`).
 *
 * Emits correlated diagnostic logs across the provider boundary.
 */
export async function extractYouTubeTranscript(
    videoId: string,
    env: AppEnv,
    options: {
        lang?: string
        forceAiTranscription?: boolean
        signal?: AbortSignal
        timeoutMs?: number
        requestId?: string
        disableFallback?: boolean
        transcriptApi?: {
            listTranscripts(videoId: string): Promise<TranscriptList | Iterable<Transcript>>
        }
    } = {}
): Promise<ExtractTranscriptPipelineResult> {
    const { forceAiTranscription = false, lang } = options
    const requestId = options.requestId || generateCorrelationId()
    const runtime = detectExecutionRuntime()

    // 1. Explicit AI transcription (requires user confirmation)
    if (forceAiTranscription) {
        const apiKey = env.SUPADATA_API_KEY
        if (!apiKey || !apiKey.trim()) {
            throw new SupadataError(
                "SUPADATA_API_KEY is not configured in server secrets.",
                "MISSING_API_KEY",
                500,
                false
            )
        }

        const startResult = await startAiTranscription(videoId, apiKey, {
            lang,
            signal: options.signal,
            timeoutMs: options.timeoutMs,
        })

        if (startResult.transcript) {
            return {
                transcript: {
                    ...startResult.transcript,
                    provider: "supadata-ai",
                },
                provider: "supadata-ai",
                needsConfirmation: false,
            }
        }

        if (startResult.jobId) {
            const polled = await pollAiTranscriptionJob(startResult.jobId, videoId, apiKey, {
                lang,
                signal: options.signal,
            })
            return {
                transcript: {
                    ...polled,
                    provider: "supadata-ai",
                },
                provider: "supadata-ai",
                needsConfirmation: false,
            }
        }

        throw new SupadataError(
            "Supadata AI transcription returned neither transcript nor jobId.",
            "PROVIDER_ERROR",
            500,
            false
        )
    }

    // 2. Primary Provider: extract-youtube
    let primaryResult = await fetchCaptionsFromExtractYoutube(videoId, {
        lang,
        signal: options.signal,
        timeoutMs: options.timeoutMs,
        transcriptApi: options.transcriptApi,
        requestId,
        attempt: 1,
    })

    // Bounded retry (1 retry) on transient errors if not aborted
    if (!primaryResult.found && primaryResult.isRetryable && !options.signal?.aborted) {
        logDiagnostic({
            event: "extract_youtube.retry_started",
            requestId,
            videoId,
            provider: "extract-youtube",
            attempt: 2,
            runtime,
        })
        await new Promise((resolve) => setTimeout(resolve, 500))
        primaryResult = await fetchCaptionsFromExtractYoutube(videoId, {
            lang,
            signal: options.signal,
            timeoutMs: options.timeoutMs,
            transcriptApi: options.transcriptApi,
            requestId,
            attempt: 2,
        })
    }

    if (primaryResult.found) {
        return {
            transcript: primaryResult.transcript,
            provider: "extract-youtube",
            needsConfirmation: false,
        }
    }

    // Phase 7: Optional diagnostic mode to safely disable fallback
    const disableFallback =
        options.disableFallback ?? (env.DISABLE_TRANSCRIPT_FALLBACK === "true")
    if (disableFallback) {
        return {
            transcript: null,
            provider: null,
            needsConfirmation: true,
            message: `Primary caption extraction failed (${primaryResult.message}) and fallback is disabled for diagnostic testing.`,
            diagnostic: {
                event: "extract_youtube.failed",
                requestId,
                provider: "extract-youtube",
                failureCategory: primaryResult.failureCategory,
                message: primaryResult.message,
            },
        }
    }

    // 3. Fallback Provider: Supadata native captions
    logDiagnostic({
        event: "transcript_provider.fallback_started",
        requestId,
        videoId,
        provider: "extract-youtube",
        fallbackProvider: "supadata",
        failureCategory: primaryResult.failureCategory,
        runtime,
    })

    const apiKey = env.SUPADATA_API_KEY
    if (!apiKey || !apiKey.trim()) {
        if (
            primaryResult.failureCategory === "captions_unavailable" ||
            primaryResult.failureCategory === "empty_transcript" ||
            primaryResult.reason === "no_captions"
        ) {
            return {
                transcript: null,
                provider: null,
                needsConfirmation: true,
                message:
                    "No native captions found. AI speech-to-text transcription is available with user confirmation.",
                diagnostic: {
                    event: "transcript_provider.fallback_failed",
                    requestId,
                    provider: "supadata",
                    failureCategory: primaryResult.failureCategory,
                    message: "SUPADATA_API_KEY not configured for fallback.",
                },
            }
        }
        throw new SupadataError(
            `Primary caption extraction failed (${primaryResult.message}) and Supadata fallback is unavailable because SUPADATA_API_KEY is not configured in server secrets.`,
            "MISSING_API_KEY",
            500,
            false
        )
    }

    const fallbackStartTime = Date.now()
    const nativeResult = await fetchNativeCaptions(videoId, apiKey, {
        lang,
        signal: options.signal,
        timeoutMs: options.timeoutMs,
    })
    const fallbackDuration = Date.now() - fallbackStartTime

    if (nativeResult.found) {
        logDiagnostic({
            event: "transcript_provider.fallback_completed",
            requestId,
            videoId,
            fallbackProvider: "supadata",
            success: true,
            captionCount: nativeResult.transcript.segments.length,
            durationMs: fallbackDuration,
            language: nativeResult.transcript.lang,
            runtime,
        })

        return {
            transcript: {
                ...nativeResult.transcript,
                provider: "supadata",
            },
            provider: "supadata",
            needsConfirmation: false,
            diagnostic: {
                event: "transcript_provider.fallback_started",
                requestId,
                provider: "extract-youtube",
                failureCategory: primaryResult.failureCategory,
                message: `Primary provider failed (${primaryResult.message}); fell back to Supadata successfully.`,
            },
        }
    }

    logDiagnostic({
        event: "transcript_provider.fallback_failed",
        requestId,
        videoId,
        fallbackProvider: "supadata",
        success: false,
        errorMessage: nativeResult.message,
        failureCategory:
            nativeResult.reason === "no_captions" ? "captions_unavailable" : "http_error",
        durationMs: fallbackDuration,
        runtime,
    })

    return {
        transcript: null,
        provider: null,
        needsConfirmation: true,
        message:
            "No native captions found. AI speech-to-text transcription is available with user confirmation.",
        diagnostic: {
            event: "transcript_provider.fallback_failed",
            requestId,
            provider: "supadata",
            failureCategory:
                nativeResult.reason === "no_captions" ? "captions_unavailable" : "http_error",
            message: `Both primary (extract-youtube: ${primaryResult.message}) and fallback (supadata: ${nativeResult.message}) failed.`,
        },
    }
}
