/**
 * Provider adapter for Supadata YouTube Transcript API.
 * Encapsulates all external HTTP requests, error discrimination, and normalization.
 */

import { YOUTUBE_CHAT_CONFIG } from "./youtube-model-config"
import type { NormalizedTranscript, TranscriptSegment } from "./youtube-types"
import { detectYouTubeVideoLanguage } from "./youtube-metadata"

export interface SupadataSegmentRaw {
    text: string
    offset: number // in milliseconds
    duration: number // in milliseconds
    lang?: string
}

export interface SupadataTranscriptResponse {
    lang?: string
    content?: SupadataSegmentRaw[] | string
    availableLangs?: string[]
}

export interface SupadataJobResponse {
    jobId?: string
    status?: "queued" | "processing" | "completed" | "failed"
    content?: SupadataSegmentRaw[] | string
    error?: string
    lang?: string
    availableLangs?: string[]
}

export type SupadataErrorCode =
    | "MISSING_API_KEY"
    | "INVALID_API_KEY"
    | "RATE_LIMIT"
    | "INSUFFICIENT_CREDITS"
    | "NO_CAPTIONS"
    | "VIDEO_UNAVAILABLE"
    | "TIMEOUT"
    | "PROVIDER_ERROR"

export class SupadataError extends Error {
    readonly code: SupadataErrorCode
    readonly statusCode?: number
    readonly isRetryable: boolean

    constructor(
        message: string,
        code: SupadataErrorCode,
        statusCode?: number,
        isRetryable: boolean = false
    ) {
        super(message)
        this.name = "SupadataError"
        this.code = code
        this.statusCode = statusCode
        this.isRetryable = isRetryable
    }
}

/**
 * Normalizes raw Supadata segments (milliseconds) into canonical TranscriptSegments (seconds).
 */
export function normalizeSupadataSegments(
    rawSegments: SupadataSegmentRaw[],
    videoId: string,
    source: "native" | "ai",
    lang: string = "en",
    version: number = 1
): NormalizedTranscript {
    const segments: TranscriptSegment[] = []
    let maxEndSeconds = 0

    for (let i = 0; i < rawSegments.length; i++) {
        const item = rawSegments[i]
        const text = (item.text || "").replace(/\s+/g, " ").trim()
        if (!text) continue

        const startSeconds = Math.max(0, Number(item.offset || 0) / 1000)
        const durationSeconds = Math.max(0.1, Number(item.duration || 0) / 1000)
        const endSeconds = startSeconds + durationSeconds

        if (endSeconds > maxEndSeconds) {
            maxEndSeconds = endSeconds
        }

        segments.push({
            id: `seg_${i}`,
            startSeconds: Number(startSeconds.toFixed(2)),
            endSeconds: Number(endSeconds.toFixed(2)),
            text,
            lang: item.lang || lang,
        })
    }

    const fullText = segments.map((s) => s.text).join(" ")

    return {
        videoId,
        lang,
        source,
        segments,
        fullText,
        duration: Math.ceil(maxEndSeconds),
        version,
    }
}

export type NativeCaptionResult =
    | { found: true; transcript: NormalizedTranscript }
    | {
          found: false
          reason: "no_captions" | "video_unavailable" | "private"
          message: string
      }

/**
 * Requests existing platform captions using Supadata native-caption mode.
 * Never triggers paid AI generation.
 */
export async function fetchNativeCaptions(
    videoId: string,
    apiKey: string,
    options: {
        signal?: AbortSignal
        lang?: string
        timeoutMs?: number
    } = {}
): Promise<NativeCaptionResult> {
    if (!apiKey || !apiKey.trim()) {
        throw new SupadataError(
            "Supadata API key is not configured. Please set SUPADATA_API_KEY in server secrets.",
            "MISSING_API_KEY",
            500,
            false
        )
    }

    let targetLang = options.lang
    if (!targetLang) {
        try {
            const detected = await detectYouTubeVideoLanguage(videoId, { signal: options.signal })
            if (detected?.baseLang) {
                targetLang = detected.baseLang
            }
        } catch {
            // Language detection fallback
        }
    }

    const canonicalUrl = `https://www.youtube.com/watch?v=${videoId}`
    const endpoint = new URL(`${YOUTUBE_CHAT_CONFIG.supadataBaseUrl}/transcript`)
    endpoint.searchParams.set("url", canonicalUrl)
    endpoint.searchParams.set("mode", "native")
    if (targetLang) {
        endpoint.searchParams.set("lang", targetLang)
    }

    const timeoutMs = options.timeoutMs || YOUTUBE_CHAT_CONFIG.requestTimeoutMs
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    try {
        const combinedSignal = options.signal
            ? AbortSignal.any([options.signal, controller.signal])
            : controller.signal

        const res = await fetch(endpoint.toString(), {
            method: "GET",
            headers: {
                "x-api-key": apiKey.trim(),
                Accept: "application/json",
            },
            signal: combinedSignal,
        })

        clearTimeout(timer)

        if (res.status === 200) {
            let data = (await res.json()) as SupadataTranscriptResponse

            // Check if availableLangs contains our target language (e.g. "bn") but Supadata returned "en" by default
            if (
                targetLang &&
                data.lang &&
                data.lang !== targetLang &&
                Array.isArray(data.availableLangs) &&
                data.availableLangs.some((l) =>
                    l.toLowerCase().startsWith(targetLang!.toLowerCase())
                )
            ) {
                try {
                    const retryEndpoint = new URL(endpoint.toString())
                    retryEndpoint.searchParams.set("lang", targetLang)
                    const retryRes = await fetch(retryEndpoint.toString(), {
                        method: "GET",
                        headers: {
                            "x-api-key": apiKey.trim(),
                            Accept: "application/json",
                        },
                        signal: combinedSignal,
                    })
                    if (retryRes.status === 200) {
                        data = (await retryRes.json()) as SupadataTranscriptResponse
                    }
                } catch {
                    // Retain original data
                }
            }

            if (Array.isArray(data.content) && data.content.length > 0) {
                const effectiveLang = data.lang || targetLang || "en"
                const normalized = normalizeSupadataSegments(
                    data.content,
                    videoId,
                    "native",
                    effectiveLang
                )
                if (normalized.segments.length > 0) {
                    return { found: true, transcript: normalized }
                }
            }
            return {
                found: false,
                reason: "no_captions",
                message: "No native caption segments found in transcript payload.",
            }
        }

        // Native captions unavailable responses: 404, 206, or 400
        if (res.status === 404 || res.status === 206) {
            return {
                found: false,
                reason: "no_captions",
                message: "Native captions are not available for this YouTube video.",
            }
        }

        // Status code discrimination
        if (res.status === 401 || res.status === 403) {
            throw new SupadataError(
                "Invalid Supadata API key or forbidden request.",
                "INVALID_API_KEY",
                res.status,
                false
            )
        }

        if (res.status === 402) {
            throw new SupadataError(
                "Insufficient Supadata API credits to retrieve transcript.",
                "INSUFFICIENT_CREDITS",
                402,
                false
            )
        }

        if (res.status === 429) {
            throw new SupadataError(
                "Supadata API rate limit exceeded. Please wait and retry.",
                "RATE_LIMIT",
                429,
                true
            )
        }

        const errText = await res.text().catch(() => "")
        if (
            errText.toLowerCase().includes("private") ||
            errText.toLowerCase().includes("unavailable")
        ) {
            return {
                found: false,
                reason: "video_unavailable",
                message: "The requested YouTube video is private, restricted, or unavailable.",
            }
        }

        if (
            errText.toLowerCase().includes("no caption") ||
            errText.toLowerCase().includes("caption not found") ||
            errText.toLowerCase().includes("transcript not found")
        ) {
            return {
                found: false,
                reason: "no_captions",
                message: "Native captions are not available for this YouTube video.",
            }
        }

        throw new SupadataError(
            `Supadata API error (${res.status}): ${errText || res.statusText}`,
            "PROVIDER_ERROR",
            res.status,
            res.status >= 500
        )
    } catch (err: unknown) {
        clearTimeout(timer)
        if (err instanceof SupadataError) {
            throw err
        }
        const isAbort =
            err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")
        if (isAbort) {
            throw new SupadataError("Request to Supadata API timed out.", "TIMEOUT", 408, true)
        }
        throw new SupadataError(
            err instanceof Error ? err.message : "Network error contacting Supadata API.",
            "PROVIDER_ERROR",
            500,
            true
        )
    }
}

/**
 * Initiates explicit AI speech-to-text transcription via Supadata.
 * Only called after explicit user confirmation.
 */
export async function startAiTranscription(
    videoId: string,
    apiKey: string,
    options: {
        signal?: AbortSignal
        lang?: string
        timeoutMs?: number
    } = {}
): Promise<{ jobId?: string; transcript?: NormalizedTranscript }> {
    if (!apiKey || !apiKey.trim()) {
        throw new SupadataError(
            "Supadata API key is not configured.",
            "MISSING_API_KEY",
            500,
            false
        )
    }

    let targetLang = options.lang
    if (!targetLang) {
        try {
            const detected = await detectYouTubeVideoLanguage(videoId, { signal: options.signal })
            if (detected?.baseLang) {
                targetLang = detected.baseLang
            }
        } catch {
            // Language detection fallback
        }
    }

    const canonicalUrl = `https://www.youtube.com/watch?v=${videoId}`
    const endpoint = new URL(`${YOUTUBE_CHAT_CONFIG.supadataBaseUrl}/transcript`)
    endpoint.searchParams.set("url", canonicalUrl)
    endpoint.searchParams.set("mode", "generate")
    if (targetLang) {
        endpoint.searchParams.set("lang", targetLang)
    }

    const timeoutMs = options.timeoutMs || YOUTUBE_CHAT_CONFIG.requestTimeoutMs
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    try {
        const combinedSignal = options.signal
            ? AbortSignal.any([options.signal, controller.signal])
            : controller.signal

        const res = await fetch(endpoint.toString(), {
            method: "GET",
            headers: {
                "x-api-key": apiKey.trim(),
                Accept: "application/json",
            },
            signal: combinedSignal,
        })

        clearTimeout(timer)

        // Immediate completion (HTTP 200)
        if (res.status === 200) {
            const data = (await res.json()) as SupadataTranscriptResponse
            if (Array.isArray(data.content) && data.content.length > 0) {
                const normalized = normalizeSupadataSegments(
                    data.content,
                    videoId,
                    "ai",
                    data.lang || targetLang || "en"
                )
                return { transcript: normalized }
            }
        }

        // Asynchronous job scheduled (HTTP 202)
        if (res.status === 202) {
            const data = (await res.json()) as SupadataJobResponse
            if (data.jobId) {
                return { jobId: data.jobId }
            }
        }

        if (res.status === 402) {
            throw new SupadataError(
                "Insufficient Supadata credits for AI transcription.",
                "INSUFFICIENT_CREDITS",
                402,
                false
            )
        }

        if (res.status === 429) {
            throw new SupadataError("Supadata API rate limit exceeded.", "RATE_LIMIT", 429, true)
        }

        const errText = await res.text().catch(() => "")
        throw new SupadataError(
            `Supadata AI transcription request failed (${res.status}): ${errText}`,
            "PROVIDER_ERROR",
            res.status,
            res.status >= 500
        )
    } catch (err: unknown) {
        clearTimeout(timer)
        if (err instanceof SupadataError) throw err
        throw new SupadataError(
            err instanceof Error ? err.message : "Failed to initiate AI transcription",
            "PROVIDER_ERROR",
            500,
            true
        )
    }
}

/**
 * Polls an asynchronous transcription job until completion, failure, or timeout.
 */
export async function pollAiTranscriptionJob(
    jobId: string,
    videoId: string,
    apiKey: string,
    options: {
        signal?: AbortSignal
        lang?: string
        maxPollRetries?: number
        pollIntervalMs?: number
    } = {}
): Promise<NormalizedTranscript> {
    const maxRetries = options.maxPollRetries || YOUTUBE_CHAT_CONFIG.maxPollRetries
    const intervalMs = options.pollIntervalMs || YOUTUBE_CHAT_CONFIG.pollIntervalMs
    const endpoint = `${YOUTUBE_CHAT_CONFIG.supadataBaseUrl}/transcript/${encodeURIComponent(jobId)}`

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        if (options.signal?.aborted) {
            throw new SupadataError("Transcription polling aborted.", "TIMEOUT", 408, false)
        }

        const res = await fetch(endpoint, {
            method: "GET",
            headers: {
                "x-api-key": apiKey.trim(),
                Accept: "application/json",
            },
            signal: options.signal,
        })

        if (res.status === 200) {
            const data = (await res.json()) as SupadataJobResponse
            if (data.status === "completed" && Array.isArray(data.content)) {
                return normalizeSupadataSegments(
                    data.content,
                    videoId,
                    "ai",
                    data.lang || options.lang || "en"
                )
            }
            if (data.status === "failed") {
                throw new SupadataError(
                    `AI transcription job failed: ${data.error || "Unknown error"}`,
                    "PROVIDER_ERROR",
                    500,
                    false
                )
            }
        } else if (res.status === 402) {
            throw new SupadataError(
                "Insufficient credits for AI transcription.",
                "INSUFFICIENT_CREDITS",
                402,
                false
            )
        } else if (res.status !== 202 && res.status !== 200) {
            if (res.status >= 500) {
                // Transient server error during poll: wait and retry
            } else {
                const errText = await res.text().catch(() => "")
                throw new SupadataError(
                    `Error polling job (${res.status}): ${errText}`,
                    "PROVIDER_ERROR",
                    res.status,
                    false
                )
            }
        }

        await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }

    throw new SupadataError(
        "AI transcription job timed out while waiting for completion.",
        "TIMEOUT",
        408,
        true
    )
}
