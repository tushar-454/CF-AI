/**
 * Diagnostics, structured logging, and failure classification for YouTube caption extraction.
 * Formats JSON-style logs with consistent prefix `[youtube-transcript]` for observation in
 * `wrangler tail` and local development, while ensuring sensitive data (API keys, full transcripts)
 * is never exposed.
 */

export type YoutubeFailureCategory =
    | "invalid_video_id"
    | "video_unavailable"
    | "captions_unavailable"
    | "language_unavailable"
    | "youtube_blocked_or_rate_limited"
    | "network_error"
    | "timeout"
    | "http_error"
    | "package_error"
    | "invalid_response"
    | "empty_transcript"
    | "invalid_timestamps"
    | "cloudflare_runtime_incompatibility"
    | "unknown"

export type YoutubeLogEvent =
    | "scrapingbee.started"
    | "scrapingbee.video_id_validated"
    | "scrapingbee.request_started"
    | "scrapingbee.response_received"
    | "scrapingbee.transcript_received"
    | "scrapingbee.transcript_validation_failed"
    | "scrapingbee.failed"
    | "scrapingbee.retry_started"
    | "scrapingbee.completed"
    | "extract_youtube.started"
    | "extract_youtube.video_id_validated"
    | "extract_youtube.request_started"
    | "extract_youtube.response_received"
    | "extract_youtube.transcript_received"
    | "extract_youtube.transcript_validation_failed"
    | "extract_youtube.failed"
    | "extract_youtube.retry_started"
    | "extract_youtube.completed"
    | "transcript_provider.fallback_started"
    | "transcript_provider.fallback_completed"
    | "transcript_provider.fallback_failed"

export interface StructuredLogPayload {
    event: YoutubeLogEvent
    requestId: string
    videoId?: string
    provider?: string
    attempt?: number
    durationMs?: number
    runtime?: string
    success?: boolean
    errorName?: string
    errorMessage?: string
    errorCode?: string | number
    httpStatus?: number
    errorCause?: string
    stack?: string
    fallbackProvider?: string
    captionCount?: number
    totalCharacters?: number
    language?: string
    failureCategory?: YoutubeFailureCategory
    urlTarget?: string
    validationError?: string
    playabilityStatus?: string
    playabilityReason?: string
}

export interface SanitizedDiagnosticEvent {
    event: string
    requestId: string
    provider: string
    failureCategory: YoutubeFailureCategory
    message: string
}

/**
 * Generates a unique correlation ID for tracing extraction requests
 * between client SSE streams and Cloudflare Worker logs.
 */
export function generateCorrelationId(prefix: string = "yt"): string {
    const timestamp = Date.now().toString(36)
    const randomPart = Math.random().toString(36).slice(2, 8)
    return `${prefix}_${timestamp}_${randomPart}`
}

/**
 * Identifies the current server runtime environment (e.g. Cloudflare Worker workerd, Node.js).
 */
export function detectExecutionRuntime(): string {
    if (typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers") {
        return "cloudflare-workers"
    }
    if (typeof process !== "undefined" && process.versions?.node) {
        return `node-${process.versions.node}`
    }
    return "workerd"
}

/**
 * Sanitizes URLs to remove sensitive query parameters while keeping host and path for logging.
 */
export function sanitizeRequestUrl(rawUrl: string): string {
    try {
        let sanitized = rawUrl.replace(/([?&]api_key=)[^&]+/gi, "$1[REDACTED]")
        sanitized = sanitized.replace(/([?&]key=)[^&]+/gi, "$1[REDACTED]")
        const parsed = new URL(sanitized)
        if (parsed.hostname.includes("scrapingbee.com")) {
            return sanitized
        }
        if (parsed.hostname.includes("youtube.com")) {
            if (parsed.pathname === "/watch") {
                const vid = parsed.searchParams.get("v")
                return `https://www.youtube.com/watch?v=${vid || "unknown"}`
            }
            if (parsed.pathname.includes("/player")) {
                return `https://www.youtube.com${parsed.pathname}`
            }
            if (parsed.pathname.includes("/timedtext")) {
                const lang = parsed.searchParams.get("lang")
                return `https://www.youtube.com/api/timedtext?lang=${lang || "unknown"}`
            }
        }
        return `${parsed.origin}${parsed.pathname}`
    } catch {
        return rawUrl.split("?")[0]
    }
}

/**
 * Strips secrets, auth headers, and full transcript texts from structured payloads.
 */
export function sanitizeStructuredLog(payload: StructuredLogPayload): StructuredLogPayload {
    const sanitized: StructuredLogPayload = { ...payload }

    // Redact any message containing accidental secret patterns
    if (sanitized.errorMessage && /bearer\s+|key=|api_key=|secret=/i.test(sanitized.errorMessage)) {
        sanitized.errorMessage = sanitized.errorMessage.replace(
            /(bearer\s+[\w.-]+|key=[\w.-]+|api_key=[\w.-]+|secret=[\w.-]+)/gi,
            "[REDACTED]"
        )
    }

    if (sanitized.errorCause && /bearer\s+|key=|api_key=|secret=/i.test(sanitized.errorCause)) {
        sanitized.errorCause = sanitized.errorCause.replace(
            /(bearer\s+[\w.-]+|key=[\w.-]+|api_key=[\w.-]+|secret=[\w.-]+)/gi,
            "[REDACTED]"
        )
    }

    if (
        sanitized.playabilityStatus &&
        /bearer\s+|key=|api_key=|secret=/i.test(sanitized.playabilityStatus)
    ) {
        sanitized.playabilityStatus = sanitized.playabilityStatus.replace(
            /(bearer\s+[\w.-]+|key=[\w.-]+|api_key=[\w.-]+|secret=[\w.-]+)/gi,
            "[REDACTED]"
        )
    }

    if (
        sanitized.playabilityReason &&
        /bearer\s+|key=|api_key=|secret=/i.test(sanitized.playabilityReason)
    ) {
        sanitized.playabilityReason = sanitized.playabilityReason.replace(
            /(bearer\s+[\w.-]+|key=[\w.-]+|api_key=[\w.-]+|secret=[\w.-]+)/gi,
            "[REDACTED]"
        )
    }

    // Sanitize target URL if present
    if (sanitized.urlTarget) {
        sanitized.urlTarget = sanitizeRequestUrl(sanitized.urlTarget)
    }

    // Do not log stacks in production unless running in development or test
    const isDev =
        typeof process !== "undefined" &&
        (process.env?.NODE_ENV === "development" || process.env?.NODE_ENV === "test")
    if (!isDev && sanitized.stack) {
        delete sanitized.stack
    }

    return sanitized
}

/**
 * Outputs structured JSON logs with the `[youtube-transcript]` prefix for `wrangler tail`.
 */
export function logDiagnostic(payload: StructuredLogPayload): void {
    const sanitized = sanitizeStructuredLog(payload)
    const logLine = `[youtube-transcript] ${JSON.stringify(sanitized)}`

    if (
        sanitized.event === "scrapingbee.failed" ||
        sanitized.event === "extract_youtube.failed" ||
        sanitized.event === "transcript_provider.fallback_failed" ||
        sanitized.event === "scrapingbee.transcript_validation_failed" ||
        sanitized.event === "extract_youtube.transcript_validation_failed"
    ) {
        console.error(logLine)
    } else if (
        sanitized.event === "transcript_provider.fallback_started" ||
        sanitized.event === "scrapingbee.retry_started" ||
        sanitized.event === "extract_youtube.retry_started" ||
        sanitized.success === false
    ) {
        console.warn(logLine)
    } else {
        console.log(logLine)
    }
}

/**
 * Validates transcript snippets to ensure non-empty text, valid non-negative numbers,
 * and valid timestamps before declaring extraction success.
 */
export function validateTranscriptSnippets(snippets: unknown): {
    valid: boolean
    failureCategory?: YoutubeFailureCategory
    reason?: string
    count: number
    totalCharacters: number
} {
    if (!snippets || !Array.isArray(snippets)) {
        return {
            valid: false,
            failureCategory: "empty_transcript",
            reason: "Transcript returned 0 snippets.",
            count: 0,
            totalCharacters: 0,
        }
    }

    if (snippets.length === 0) {
        return {
            valid: false,
            failureCategory: "empty_transcript",
            reason: "Transcript returned 0 snippets.",
            count: 0,
            totalCharacters: 0,
        }
    }

    let readableCount = 0
    let totalCharacters = 0

    for (let i = 0; i < snippets.length; i++) {
        const item = snippets[i] as { text?: unknown; start?: unknown; duration?: unknown }
        if (!item || typeof item !== "object") {
            return {
                valid: false,
                failureCategory: "invalid_response",
                reason: `Snippet at index ${i} is not an object.`,
                count: snippets.length,
                totalCharacters,
            }
        }

        const start = Number(item.start)
        const duration = Number(item.duration)

        if (Number.isNaN(start) || Number.isNaN(duration) || start < 0 || duration < 0) {
            return {
                valid: false,
                failureCategory: "invalid_timestamps",
                reason: `Snippet at index ${i} has invalid timestamp values (start: ${item.start}, duration: ${item.duration}).`,
                count: snippets.length,
                totalCharacters,
            }
        }

        const text = typeof item.text === "string" ? item.text.trim() : ""
        if (text.length > 0) {
            readableCount++
            totalCharacters += text.length
        }
    }

    if (readableCount === 0 || totalCharacters === 0) {
        return {
            valid: false,
            failureCategory: "empty_transcript",
            reason: "All snippets contained empty or whitespace-only text.",
            count: snippets.length,
            totalCharacters: 0,
        }
    }

    return {
        valid: true,
        count: readableCount,
        totalCharacters,
    }
}

/**
 * Classifies YouTube extraction exceptions into concrete diagnostic categories
 * while preserving original error names, messages, causes, HTTP status, and stacks.
 */
export function classifyYoutubeError(
    err: unknown,
    context?: {
        httpStatus?: number
        videoId?: string
        playabilityStatus?: string
        playabilityReason?: string
    }
): {
    category: YoutubeFailureCategory
    message: string
    errorName: string
    errorCode?: string | number
    httpStatus?: number
    errorCause?: string
    stack?: string
    playabilityStatus?: string
    playabilityReason?: string
} {
    let errorName = "UnknownError"
    let message = "Unknown transcript extraction error."
    let errorCause: string | undefined
    let stack: string | undefined
    let httpStatus = context?.httpStatus
    let errorCode: string | number | undefined
    let playabilityStatus = context?.playabilityStatus
    let playabilityReason = context?.playabilityReason

    if (err instanceof Error) {
        errorName = err.name || err.constructor?.name || "Error"
        message = err.message || message
        stack = err.stack
        if (err.cause) {
            errorCause =
                err.cause instanceof Error
                    ? err.cause.message
                    : typeof err.cause === "string"
                      ? err.cause
                      : JSON.stringify(err.cause)
        }
    } else if (err && typeof err === "object") {
        const errObj = err as Record<string, unknown>
        if (typeof errObj.message === "string") {
            message = errObj.message
        }
        if (typeof errObj.name === "string") {
            errorName = errObj.name
        }
    } else if (typeof err === "string") {
        message = err
    }

    // Extract any embedded HTTP status code (e.g. from `YouTubeRequestFailed: HTTP 403: Forbidden`)
    const statusMatch = message.match(/HTTP\s+(\d{3})/i)
    if (statusMatch && !httpStatus) {
        httpStatus = parseInt(statusMatch[1], 10)
    }

    // Inspect error properties if object
    if (err && typeof err === "object") {
        const errObj = err as Record<string, unknown>
        if (typeof errObj.code === "string" || typeof errObj.code === "number") {
            errorCode = errObj.code
        }
        if (typeof errObj.status === "number" && !httpStatus) {
            httpStatus = errObj.status
        }
        if (!playabilityStatus && typeof errObj.playabilityStatus === "string") {
            playabilityStatus = errObj.playabilityStatus
        }
        if (!playabilityReason && typeof errObj.playabilityReason === "string") {
            playabilityReason = errObj.playabilityReason
        }
        if (!playabilityReason && typeof errObj.unplayableReason === "string") {
            playabilityReason = errObj.unplayableReason
        }
        if (typeof errObj.causeMessage === "string" && !errorCause) {
            errorCause = errObj.causeMessage
        }
        if (typeof errObj.httpErrorReason === "string") {
            errorCause = (errorCause ? `${errorCause}; ` : "") + errObj.httpErrorReason
            const innerMatch = errObj.httpErrorReason.match(/HTTP\s+(\d{3})/i)
            if (innerMatch && !httpStatus) {
                httpStatus = parseInt(innerMatch[1], 10)
            }
        }
    }

    const buildResult = (
        category: YoutubeFailureCategory,
        fallbackMessage?: string,
        customStatus?: number
    ) => ({
        category,
        message:
            message && message !== "Unknown transcript extraction error."
                ? message
                : fallbackMessage || message,
        errorName,
        errorCode,
        httpStatus: customStatus ?? httpStatus,
        errorCause,
        stack,
        playabilityStatus,
        playabilityReason,
    })

    // 1. Invalid Video ID
    if (
        errorName === "InvalidVideoId" ||
        /invalid\s+video\s+id/i.test(message) ||
        (context?.videoId && !/^[a-zA-Z0-9_-]{11}$/.test(context.videoId))
    ) {
        return buildResult("invalid_video_id", "Invalid YouTube video ID format.")
    }

    // 2. Video Unavailable / Unplayable / Age-Restricted
    if (
        errorName === "VideoUnavailable" ||
        errorName === "VideoUnplayable" ||
        errorName === "AgeRestricted" ||
        /video\s+is\s+(unavailable|private|unplayable|restricted)/i.test(message)
    ) {
        return buildResult("video_unavailable", "Video is private, restricted, or unavailable.")
    }

    // 3. Rate Limited / Bot Blocked / PoToken Required
    if (
        errorName === "IpBlocked" ||
        errorName === "RequestBlocked" ||
        errorName === "PoTokenRequired" ||
        errorName === "FailedToCreateConsentCookie" ||
        httpStatus === 429 ||
        /bot\s+detection|rate\s+limit|too\s+many\s+requests|po\s+token|blocking\s+requests\s+from\s+your\s+ip/i.test(
            message
        )
    ) {
        return buildResult(
            "youtube_blocked_or_rate_limited",
            "YouTube request blocked by rate limiting or bot challenge.",
            httpStatus || 429
        )
    }

    // 4. Captions Disabled / Unavailable
    if (
        errorName === "NoTranscriptFound" ||
        errorName === "TranscriptsDisabled" ||
        httpStatus === 404 ||
        httpStatus === 204 ||
        /subtitles\s+are\s+disabled|no\s+transcript\s+found|no\s+caption\s+tracks|no\s+subtitles\s+found|captions\s+are\s+unavailable/i.test(
            message
        )
    ) {
        return buildResult(
            "captions_unavailable",
            "Captions are disabled or unavailable for this video."
        )
    }

    // 4a. ScrapingBee Auth & Quota Errors
    if (httpStatus === 401 || /invalid\s+(api\s+)?key|unauthorized/i.test(message)) {
        const res = buildResult("http_error", undefined, 401)
        res.message = "Invalid ScrapingBee API key or unauthorized request."
        return res
    }
    if (httpStatus === 403 || /credit\s+limit|forbidden/i.test(message)) {
        const res = buildResult("http_error", undefined, 403)
        res.message = "ScrapingBee credit limit exceeded or feature forbidden."
        return res
    }

    // 5. Language Unavailable / Not Translatable
    if (
        errorName === "TranslationLanguageNotAvailable" ||
        errorName === "NotTranslatable" ||
        /language\s+is\s+not\s+(available|translatable)/i.test(message)
    ) {
        return buildResult("language_unavailable", "Requested caption language is unavailable.")
    }

    // 6. Network Timeout
    if (
        errorName === "AbortError" ||
        errorName === "TimeoutError" ||
        /timed?\s*out/i.test(message)
    ) {
        return buildResult("timeout", "Primary caption extraction request timed out.")
    }

    // 7. Network Error
    if (
        /fetch\s+failed|network\s+error|econnrefused|enotfound|ehostunreach/i.test(message) ||
        (errorName === "TypeError" && /fetch/i.test(message))
    ) {
        return buildResult(
            "network_error",
            "Network connection failure communicating with YouTube."
        )
    }

    // 8. Cloudflare Runtime Incompatibility
    if (
        errorName === "ReferenceError" ||
        /module\s+not\s+found|unsupported\s+runtime|is\s+not\s+defined|cannot\s+read\s+properties\s+of\s+undefined\s+\(reading\s+'(window|document)'\)/i.test(
            message
        )
    ) {
        return buildResult(
            "cloudflare_runtime_incompatibility",
            "Runtime API or module incompatibility in serverless environment."
        )
    }

    // 9. HTTP Error (Non-2xx status code that is not 429)
    if (httpStatus && httpStatus >= 400) {
        return buildResult("http_error", `YouTube HTTP request failed with status ${httpStatus}.`)
    }

    // 10. Package / Parser Error
    if (
        errorName === "YouTubeDataUnparsable" ||
        /data\s+required\s+to\s+fetch\s+the\s+transcript\s+is\s+not\s+parsable|xml\s+parsing|unexpected\s+token/i.test(
            message
        )
    ) {
        return buildResult("package_error", "YouTube caption payload was unparsable.")
    }

    // 11. Empty Transcript / Invalid Timestamps
    if (/0\s+snippets|contained\s+no\s+readable\s+text/i.test(message)) {
        return buildResult("empty_transcript", "Transcript contained no readable caption text.")
    }
    if (/invalid\s+timestamp/i.test(message)) {
        return buildResult(
            "invalid_timestamps",
            "Transcript contained invalid or malformed timestamp cues."
        )
    }

    // 12. Default Unknown
    return buildResult("unknown", message || "Unknown YouTube extraction error.")
}

/**
 * Determines whether an error category is transient and eligible for a bounded retry.
 */
export function isRetryableFailureCategory(category: YoutubeFailureCategory): boolean {
    return category === "timeout" || category === "network_error"
}
