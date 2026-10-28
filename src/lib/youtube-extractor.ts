/**
 * Primary YouTube subtitle extractor using ScrapingBee's official YouTube Subtitles API
 * (/api/v1/youtube/subtitles). ScrapingBee is the sole transcript provider; all Supadata
 * calls and fallback paths are completely disabled.
 * Fully instrumented with structured diagnostics and failure classification.
 */

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

export class ScrapingBeeError extends Error {
    readonly statusCode?: number
    readonly isRetryable: boolean
    readonly failureCategory?: YoutubeFailureCategory

    constructor(
        message: string,
        statusCode?: number,
        isRetryable: boolean = false,
        failureCategory?: YoutubeFailureCategory
    ) {
        super(message)
        this.name = "ScrapingBeeError"
        this.statusCode = statusCode
        this.isRetryable = isRetryable
        this.failureCategory = failureCategory
    }
}

export interface ScrapingBeeSubtitleCue {
    text?: string
    start?: number | string
    duration?: number | string
    start_ms?: number | string
    d_duration_ms?: number | string
    duration_ms?: number | string
    snippet?: {
        runs?: Array<{ text?: string }>
        text?: string
    }
}

export interface ScrapingBeeSubtitlesResponse {
    video_id?: string
    language?: string
    subtitle_origin?: string
    subtitles?:
        | ScrapingBeeSubtitleCue[]
        | Record<string, Record<string, ScrapingBeeSubtitleCue[]>>
        | unknown
}

export interface ScrapingBeeSubtitlesOptions {
    lang?: string
    signal?: AbortSignal
    timeoutMs?: number
    requestId?: string
    attempt?: number
    subtitleOrigin?: "auto_generated" | "uploader_provided" | "auto" | "manual"
    fetchFn?: typeof fetch
    disableFallback?: boolean
    playerResponse?: {
        playabilityStatus?: string
        playabilityReason?: string
    }
}

export type ExtractYoutubeOptions = ScrapingBeeSubtitlesOptions

export type ScrapingBeeFailureReason =
    | YoutubeFailureCategory
    | "no_captions"
    | "blocked"
    | "video_unavailable"
    | "network_error"
    | "timeout"
    | "malformed"
    | "error"

export type ExtractYoutubeFailureReason = ScrapingBeeFailureReason

export type ScrapingBeeResult =
    | {
          found: true
          transcript: NormalizedTranscript
          isGenerated: boolean
          languageCode: string
          provider: "scrapingbee"
          requestId: string
      }
    | {
          found: false
          reason: ScrapingBeeFailureReason
          failureCategory: YoutubeFailureCategory
          message: string
          isRetryable: boolean
          error?: unknown
          requestId: string
          httpStatus?: number
          playabilityStatus?: string
          playabilityReason?: string
      }

export type ExtractYoutubeResult = ScrapingBeeResult

export type ExtractTranscriptPipelineResult =
    | {
          transcript: NormalizedTranscript
          provider: "scrapingbee"
          needsConfirmation: false
          message?: string
          diagnostic?: YoutubeDiagnosticEvent
      }
    | {
          transcript: null
          provider: null
          needsConfirmation: boolean
          message: string
          diagnostic?: YoutubeDiagnosticEvent
      }

/**
 * Normalizes raw subtitle cues from ScrapingBee into canonical TranscriptSegments.
 * Resilient to flat objects ({ text, start, duration }), ms objects ({ start_ms, d_duration_ms }),
 * and snippet runs ({ snippet: { runs: [{ text }] } }).
 */
export function normalizeScrapingBeeSubtitles(
    rawSubtitles: ScrapingBeeSubtitleCue[] | null | undefined,
    videoId: string,
    lang: string = "en",
    version: number = 1
): NormalizedTranscript {
    const segments: TranscriptSegment[] = []
    let maxEndSeconds = 0
    const list = Array.isArray(rawSubtitles) ? rawSubtitles : []

    for (let i = 0; i < list.length; i++) {
        const item = list[i]
        if (!item || typeof item !== "object") continue

        let rawText = item.text || ""
        if (!rawText && item.snippet) {
            if (Array.isArray(item.snippet.runs)) {
                rawText = item.snippet.runs
                    .map((r) => (r && typeof r === "object" ? String(r.text || "") : ""))
                    .join("")
            } else if (typeof item.snippet.text === "string") {
                rawText = item.snippet.text
            }
        }

        const text = rawText
            .replace(/\r\n|\r|\n/g, " ")
            .replace(/\s+/g, " ")
            .trim()
        if (!text) continue

        let startVal = item.start
        if (startVal === undefined && item.start_ms !== undefined) {
            startVal = Number(item.start_ms) / 1000
        }
        let durationVal = item.duration
        if (durationVal === undefined) {
            if (item.d_duration_ms !== undefined) {
                durationVal = Number(item.d_duration_ms) / 1000
            } else if (item.duration_ms !== undefined) {
                durationVal = Number(item.duration_ms) / 1000
            }
        }

        const startSeconds = Math.max(0, Number(startVal || 0))
        const durationSeconds = Math.max(0.1, Number(durationVal || 0))
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
        provider: "scrapingbee",
        segments,
        fullText,
        duration: Math.ceil(maxEndSeconds),
        version,
    }
}

/**
 * Backward-compatible alias for existing tests and modules.
 */
export const normalizeExtractYoutubeSnippets = normalizeScrapingBeeSubtitles

/**
 * Parses and normalizes ScrapingBee YouTube Subtitles API responses.
 * Handles:
 * 1. Real ScrapingBee nested schema: { subtitles: { uploader_provided: { [lang]: [...] }, auto_generated: { [lang]: [...] } } }
 * 2. Flat subtitle cue arrays: [{ text, start, duration }]
 * 3. Wrapped array responses: { subtitles: [{ text, start, duration }], language?: string, subtitle_origin?: string }
 */
export function parseScrapingBeeSubtitles(
    data: unknown,
    options: ScrapingBeeSubtitlesOptions = {}
): {
    cues: ScrapingBeeSubtitleCue[] | null
    language: string
    isGenerated: boolean
    origin: string
} {
    const targetLang = (options.lang || "en").toLowerCase()
    const targetBase = targetLang.split("-")[0].split("_")[0]

    if (!data) {
        return { cues: null, language: targetLang, isGenerated: false, origin: "unknown" }
    }

    // Case 1: Raw array of subtitle cues
    if (Array.isArray(data)) {
        const cues = normalizeCueList(data)
        return {
            cues,
            language: targetLang,
            isGenerated: false,
            origin: "unknown",
        }
    }

    if (typeof data !== "object") {
        return { cues: null, language: targetLang, isGenerated: false, origin: "unknown" }
    }

    const payload = data as Record<string, unknown>
    const rawSubtitles = payload.subtitles

    // Case 2: Wrapped array of cues: { subtitles: [ ... ] }
    if (Array.isArray(rawSubtitles)) {
        const cues = normalizeCueList(rawSubtitles)
        const responseLang =
            (typeof payload.language === "string" && payload.language) || options.lang || "en"
        const isGen = payload.subtitle_origin === "auto_generated"
        return {
            cues,
            language: responseLang,
            isGenerated: isGen,
            origin:
                (payload.subtitle_origin as string) ||
                (isGen ? "auto_generated" : "uploader_provided"),
        }
    }

    // Case 3: Nested object: { subtitles: { uploader_provided: { en: [...] }, auto_generated: { en: [...] } } }
    if (rawSubtitles && typeof rawSubtitles === "object") {
        const subtitlesRecord = rawSubtitles as Record<string, unknown>

        const originOrder: string[] =
            options.subtitleOrigin === "auto_generated"
                ? ["auto_generated", "uploader_provided"]
                : options.subtitleOrigin === "uploader_provided"
                  ? ["uploader_provided", "auto_generated"]
                  : ["uploader_provided", "auto_generated"]

        const allOrigins = Array.from(new Set([...originOrder, ...Object.keys(subtitlesRecord)]))

        // Strategy A: Find target language matching exact or base code in preferred origins
        for (const origin of allOrigins) {
            const originObj = subtitlesRecord[origin]
            if (!originObj || typeof originObj !== "object" || Array.isArray(originObj)) continue

            const originRecord = originObj as Record<string, unknown>
            const matchedKey = findMatchingLanguageKey(originRecord, targetLang, targetBase)
            if (matchedKey && Array.isArray(originRecord[matchedKey])) {
                const cues = normalizeCueList(originRecord[matchedKey] as unknown[])
                return {
                    cues,
                    language: matchedKey,
                    isGenerated: origin === "auto_generated",
                    origin,
                }
            }
        }

        // Strategy B: If target language not found, take the first available language from preferred origins
        for (const origin of allOrigins) {
            const originObj = subtitlesRecord[origin]
            if (!originObj || typeof originObj !== "object" || Array.isArray(originObj)) continue

            const originRecord = originObj as Record<string, unknown>
            const availableKeys = Object.keys(originRecord)
            if (availableKeys.length > 0) {
                const firstKey = availableKeys[0]
                if (Array.isArray(originRecord[firstKey])) {
                    const cues = normalizeCueList(originRecord[firstKey] as unknown[])
                    return {
                        cues,
                        language: firstKey,
                        isGenerated: origin === "auto_generated",
                        origin,
                    }
                }
            }
        }
    }

    return { cues: null, language: targetLang, isGenerated: false, origin: "unknown" }
}

function findMatchingLanguageKey(
    obj: Record<string, unknown>,
    targetLang: string,
    targetBase: string
): string | null {
    const keys = Object.keys(obj)
    // 1. Exact case-insensitive match
    const exact = keys.find((k) => k.toLowerCase() === targetLang)
    if (exact) return exact
    // 2. Base code match (e.g. "en" matches "en-US", or "en-US" matches "en")
    const baseMatch = keys.find((k) => k.toLowerCase().split("-")[0].split("_")[0] === targetBase)
    if (baseMatch) return baseMatch
    return null
}

function normalizeCueList(rawList: unknown[]): ScrapingBeeSubtitleCue[] {
    const normalized: ScrapingBeeSubtitleCue[] = []
    for (const item of rawList) {
        if (!item || typeof item !== "object") continue
        const cue = item as Record<string, unknown>

        let text = ""
        if (cue.snippet && typeof cue.snippet === "object") {
            const snippet = cue.snippet as Record<string, unknown>
            if (Array.isArray(snippet.runs)) {
                text = snippet.runs
                    .map((r) =>
                        r && typeof r === "object"
                            ? String((r as Record<string, unknown>).text || "")
                            : ""
                    )
                    .join("")
            } else if (typeof snippet.text === "string") {
                text = snippet.text
            }
        } else if (typeof cue.text === "string") {
            text = cue.text
        }

        const cleanText = text.replace(/\r\n|\r|\n/g, " ").trim()
        if (!cleanText) continue

        let start = 0
        if (cue.start_ms !== undefined) {
            start = Number(cue.start_ms) / 1000
        } else if (cue.start !== undefined) {
            start = Number(cue.start)
        }

        let duration = 0
        if (cue.d_duration_ms !== undefined) {
            duration = Number(cue.d_duration_ms) / 1000
        } else if (cue.duration_ms !== undefined) {
            duration = Number(cue.duration_ms) / 1000
        } else if (cue.duration !== undefined) {
            duration = Number(cue.duration)
        }

        if (Number.isNaN(start) || Number.isNaN(duration) || start < 0 || duration < 0) {
            continue
        }

        normalized.push({
            text: cleanText,
            start: Number(start.toFixed(2)),
            duration: Number(duration.toFixed(2)),
        })
    }
    return normalized
}

/**
 * Fetches subtitles for a YouTube video using ScrapingBee's official YouTube Subtitles API endpoint.
 * Authenticates via Authorization: Bearer <API_KEY> header. Never exposes API key in URL or logs.
 */
export async function fetchSubtitlesFromScrapingBee(
    videoId: string,
    apiKey: string,
    options: ScrapingBeeSubtitlesOptions = {}
): Promise<ScrapingBeeResult> {
    const requestId = options.requestId || generateCorrelationId()
    const runtime = detectExecutionRuntime()
    const attempt = options.attempt || 1

    logDiagnostic({
        event: "scrapingbee.started",
        requestId,
        videoId,
        provider: "scrapingbee",
        attempt,
        runtime,
    })

    if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
        logDiagnostic({
            event: "scrapingbee.failed",
            requestId,
            videoId,
            provider: "scrapingbee",
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
        event: "scrapingbee.video_id_validated",
        requestId,
        videoId,
        provider: "scrapingbee",
        attempt,
        runtime,
    })

    if (!apiKey || !apiKey.trim()) {
        logDiagnostic({
            event: "scrapingbee.failed",
            requestId,
            videoId,
            provider: "scrapingbee",
            attempt,
            runtime,
            success: false,
            failureCategory: "http_error",
            errorMessage: "SCRAPINGBEE_API_KEY is not configured in server secrets.",
            durationMs: 0,
        })
        return {
            found: false,
            reason: "http_error",
            failureCategory: "http_error",
            message: "SCRAPINGBEE_API_KEY is not configured in server secrets.",
            isRetryable: false,
            requestId,
            httpStatus: 500,
        }
    }

    const startTime = Date.now()
    const timeoutMs = options.timeoutMs || YOUTUBE_CHAT_CONFIG.requestTimeoutMs || 15000

    try {
        const endpoint = new URL(YOUTUBE_CHAT_CONFIG.scrapingbeeBaseUrl)
        endpoint.searchParams.set("video_id", videoId)
        if (options.lang) {
            endpoint.searchParams.set("language", options.lang)
        }
        if (options.subtitleOrigin) {
            endpoint.searchParams.set("subtitle_origin", options.subtitleOrigin)
        }

        const timeoutSignal = AbortSignal.timeout(timeoutMs)
        const combinedSignal = options.signal
            ? AbortSignal.any([options.signal, timeoutSignal])
            : timeoutSignal

        logDiagnostic({
            event: "scrapingbee.request_started",
            requestId,
            videoId,
            provider: "scrapingbee",
            attempt,
            runtime,
            urlTarget: endpoint.toString(),
        })

        const fetcher = options.fetchFn || globalThis.fetch
        const res = await fetcher(endpoint.toString(), {
            method: "GET",
            headers: {
                Authorization: `Bearer ${apiKey.trim()}`,
                Accept: "application/json",
            },
            signal: combinedSignal,
        })

        const durationMs = Date.now() - startTime

        logDiagnostic({
            event: "scrapingbee.response_received",
            requestId,
            videoId,
            provider: "scrapingbee",
            attempt,
            runtime,
            durationMs,
            httpStatus: res.status,
            success: res.ok,
            urlTarget: endpoint.toString(),
        })

        if (res.status === 200) {
            const data = (await res.json()) as unknown
            const parsed = parseScrapingBeeSubtitles(data, options)

            const validation = validateTranscriptSnippets(parsed.cues)
            if (!parsed.cues || !validation.valid) {
                const category = validation.failureCategory || "empty_transcript"
                logDiagnostic({
                    event: "scrapingbee.transcript_validation_failed",
                    requestId,
                    videoId,
                    provider: "scrapingbee",
                    attempt,
                    runtime,
                    failureCategory: category,
                    errorMessage: validation.reason,
                    captionCount: validation.count,
                    durationMs,
                })
                logDiagnostic({
                    event: "scrapingbee.failed",
                    requestId,
                    videoId,
                    provider: "scrapingbee",
                    attempt,
                    runtime,
                    success: false,
                    failureCategory: category,
                    errorMessage: validation.reason,
                    durationMs,
                })
                return {
                    found: false,
                    reason: category,
                    failureCategory: category,
                    message: validation.reason || "Subtitles contained no readable text cues.",
                    isRetryable: false,
                    requestId,
                }
            }

            const normalized = normalizeScrapingBeeSubtitles(parsed.cues, videoId, parsed.language)

            logDiagnostic({
                event: "scrapingbee.transcript_received",
                requestId,
                videoId,
                provider: "scrapingbee",
                attempt,
                runtime,
                captionCount: normalized.segments.length,
                totalCharacters: normalized.fullText.length,
                language: normalized.lang,
                durationMs,
            })

            logDiagnostic({
                event: "scrapingbee.completed",
                requestId,
                videoId,
                provider: "scrapingbee",
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
                isGenerated: parsed.isGenerated,
                languageCode: normalized.lang,
                provider: "scrapingbee",
                requestId,
            }
        }

        if (res.status === 404 || res.status === 204) {
            logDiagnostic({
                event: "scrapingbee.failed",
                requestId,
                videoId,
                provider: "scrapingbee",
                attempt,
                runtime,
                success: false,
                failureCategory: "captions_unavailable",
                errorMessage: "Captions are unavailable for this YouTube video.",
                durationMs,
                httpStatus: res.status,
            })
            return {
                found: false,
                reason: "captions_unavailable",
                failureCategory: "captions_unavailable",
                message: "Captions are unavailable for this YouTube video.",
                isRetryable: false,
                requestId,
                httpStatus: res.status,
            }
        }

        if (res.status === 401) {
            logDiagnostic({
                event: "scrapingbee.failed",
                requestId,
                videoId,
                provider: "scrapingbee",
                attempt,
                runtime,
                success: false,
                failureCategory: "http_error",
                errorMessage: "Invalid ScrapingBee API key or unauthorized request.",
                durationMs,
                httpStatus: 401,
            })
            return {
                found: false,
                reason: "http_error",
                failureCategory: "http_error",
                message: "Invalid ScrapingBee API key or unauthorized request.",
                isRetryable: false,
                requestId,
                httpStatus: 401,
            }
        }

        if (res.status === 403) {
            logDiagnostic({
                event: "scrapingbee.failed",
                requestId,
                videoId,
                provider: "scrapingbee",
                attempt,
                runtime,
                success: false,
                failureCategory: "http_error",
                errorMessage: "ScrapingBee account credits exhausted or feature forbidden.",
                durationMs,
                httpStatus: 403,
            })
            return {
                found: false,
                reason: "http_error",
                failureCategory: "http_error",
                message: "ScrapingBee account credits exhausted or feature forbidden.",
                isRetryable: false,
                requestId,
                httpStatus: 403,
            }
        }

        if (res.status === 429) {
            logDiagnostic({
                event: "scrapingbee.failed",
                requestId,
                videoId,
                provider: "scrapingbee",
                attempt,
                runtime,
                success: false,
                failureCategory: "youtube_blocked_or_rate_limited",
                errorMessage: "ScrapingBee rate limit or concurrency limit exceeded.",
                durationMs,
                httpStatus: 429,
            })
            return {
                found: false,
                reason: "youtube_blocked_or_rate_limited",
                failureCategory: "youtube_blocked_or_rate_limited",
                message: "ScrapingBee rate limit or concurrency limit exceeded.",
                isRetryable: true,
                requestId,
                httpStatus: 429,
            }
        }

        const errorBody = await res.text().catch(() => "")
        const message = `ScrapingBee HTTP request failed with status ${res.status}${errorBody ? `: ${errorBody.slice(0, 100)}` : ""}.`
        const isRetryable = res.status >= 500

        logDiagnostic({
            event: "scrapingbee.failed",
            requestId,
            videoId,
            provider: "scrapingbee",
            attempt,
            runtime,
            success: false,
            failureCategory: "http_error",
            errorMessage: message,
            durationMs,
            httpStatus: res.status,
        })

        return {
            found: false,
            reason: "http_error",
            failureCategory: "http_error",
            message,
            isRetryable,
            requestId,
            httpStatus: res.status,
        }
    } catch (err: unknown) {
        const durationMs = Date.now() - startTime
        const classified = classifyYoutubeError(err, { videoId })

        logDiagnostic({
            event: "scrapingbee.failed",
            requestId,
            videoId,
            provider: "scrapingbee",
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
        }
    }
}

/**
 * Backward-compatible function alias.
 */
export async function fetchCaptionsFromExtractYoutube(
    videoId: string,
    options: ScrapingBeeSubtitlesOptions & { apiKey?: string; transcriptApi?: unknown } = {}
): Promise<ScrapingBeeResult> {
    return fetchSubtitlesFromScrapingBee(videoId, options.apiKey || "", options)
}

/**
 * Central orchestrator for YouTube transcript extraction.
 * ScrapingBee is the sole provider. Supadata calls and fallbacks are completely disabled.
 */
export async function extractYouTubeTranscript(
    videoId: string,
    env: AppEnv,
    options: ScrapingBeeSubtitlesOptions & {
        forceAiTranscription?: boolean
        transcriptApi?: unknown
    } = {}
): Promise<ExtractTranscriptPipelineResult> {
    const { forceAiTranscription = false } = options
    const requestId = options.requestId || generateCorrelationId()
    const runtime = detectExecutionRuntime()

    // Explicit confirmation / AI transcription path:
    // Supadata AI calls are disabled; ScrapingBee is the sole provider.
    if (forceAiTranscription) {
        return {
            transcript: null,
            provider: null,
            needsConfirmation: false,
            message:
                "AI speech-to-text transcription is disabled. ScrapingBee is the sole transcript provider.",
            diagnostic: {
                event: "scrapingbee.failed",
                requestId,
                provider: "scrapingbee",
                failureCategory: "captions_unavailable",
                message:
                    "AI speech-to-text transcription is disabled. ScrapingBee is the sole transcript provider.",
            },
        }
    }

    const apiKey = env.SCRAPINGBEE_API_KEY
    if (!apiKey || !apiKey.trim()) {
        logDiagnostic({
            event: "scrapingbee.failed",
            requestId,
            videoId,
            provider: "scrapingbee",
            attempt: 1,
            runtime,
            success: false,
            failureCategory: "http_error",
            errorMessage: "SCRAPINGBEE_API_KEY is not configured in server secrets.",
            durationMs: 0,
        })
        return {
            transcript: null,
            provider: null,
            needsConfirmation: false,
            message: "SCRAPINGBEE_API_KEY is not configured in server secrets.",
            diagnostic: {
                event: "scrapingbee.failed",
                requestId,
                provider: "scrapingbee",
                failureCategory: "http_error",
                message: "SCRAPINGBEE_API_KEY is not configured in server secrets.",
            },
        }
    }

    // Sole Provider: ScrapingBee
    let result = await fetchSubtitlesFromScrapingBee(videoId, apiKey, {
        ...options,
        requestId,
        attempt: 1,
    })

    // Bounded retry (1 retry) on transient errors if not aborted
    if (!result.found && result.isRetryable && !options.signal?.aborted) {
        logDiagnostic({
            event: "scrapingbee.retry_started",
            requestId,
            videoId,
            provider: "scrapingbee",
            attempt: 2,
            runtime,
        })
        await new Promise((resolve) => setTimeout(resolve, 500))
        result = await fetchSubtitlesFromScrapingBee(videoId, apiKey, {
            ...options,
            requestId,
            attempt: 2,
        })
    }

    if (result.found) {
        return {
            transcript: result.transcript,
            provider: "scrapingbee",
            needsConfirmation: false,
        }
    }

    // Single-provider failure: No fallback to Supadata
    return {
        transcript: null,
        provider: null,
        needsConfirmation: false,
        message: result.message,
        diagnostic: {
            event: "scrapingbee.failed",
            requestId,
            provider: "scrapingbee",
            failureCategory: result.failureCategory,
            message: result.message,
        },
    }
}
