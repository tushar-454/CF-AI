/**
 * Dedicated test suite for YouTube Caption Extractor Diagnostics, Structured Logging,
 * Error Classification, and Fallback Telemetry.
 */

import test from "node:test"
import assert from "node:assert/strict"
import {
    classifyYoutubeError,
    detectExecutionRuntime,
    generateCorrelationId,
    sanitizeStructuredLog,
    validateTranscriptSnippets,
} from "../src/lib/youtube-diagnostics.ts"
import {
    extractYouTubeTranscript,
    fetchCaptionsFromExtractYoutube,
} from "../src/lib/youtube-extractor.ts"
import {
    IpBlocked,
    NoTranscriptFound,
    RequestBlocked,
    VideoUnavailable,
    YouTubeRequestFailed,
} from "extract-youtube"

function createMockTrack({
    languageCode = "en",
    isGenerated = false,
    snippets = [
        { text: "Hello and welcome to this video.", start: 0, duration: 3.5 },
        { text: "Today we explore edge computing.", start: 3.5, duration: 4.0 },
    ],
} = {}) {
    return {
        languageCode,
        language: "English",
        isGenerated,
        translationLanguages: [],
        async fetch() {
            return {
                snippets,
                languageCode,
                language: "English",
                isGenerated,
            }
        },
    }
}

test("YouTube Caption Diagnostics and Logging Suite", async (t) => {
    // 1. Successful extract-youtube extraction emits structured logs and doesn't call fallback
    await t.test("1. Successful extract-youtube extraction emits structured logs", async () => {
        const logs = []
        const originalLog = console.log
        console.log = (msg) => {
            if (typeof msg === "string" && msg.startsWith("[youtube-transcript]")) {
                logs.push(JSON.parse(msg.replace("[youtube-transcript] ", "")))
            }
            originalLog(msg)
        }

        try {
            const mockApi = {
                async listTranscripts() {
                    return [createMockTrack()]
                },
            }

            const requestId = "test_req_success_1"
            const result = await extractYouTubeTranscript(
                "dQw4w9WgXcQ",
                { SUPADATA_API_KEY: "mock_key" },
                { lang: "en", transcriptApi: mockApi, requestId }
            )

            assert.strictEqual(result.needsConfirmation, false)
            assert.strictEqual(result.provider, "extract-youtube")
            assert.strictEqual(result.transcript.segments.length, 2)

            const events = logs.map((l) => l.event)
            assert.ok(events.includes("extract_youtube.started"))
            assert.ok(events.includes("extract_youtube.video_id_validated"))
            assert.ok(events.includes("extract_youtube.transcript_received"))
            assert.ok(events.includes("extract_youtube.completed"))
            assert.ok(!events.includes("transcript_provider.fallback_started"))

            const completed = logs.find((l) => l.event === "extract_youtube.completed")
            assert.strictEqual(completed.success, true)
            assert.strictEqual(completed.captionCount, 2)
            assert.strictEqual(completed.requestId, requestId)
        } finally {
            console.log = originalLog
        }
    })

    // 2. Package import/runtime failure classified as cloudflare_runtime_incompatibility
    await t.test("2. Runtime incompatibility error classification", () => {
        const refError = new ReferenceError("document is not defined")
        const classified = classifyYoutubeError(refError)
        assert.strictEqual(classified.category, "cloudflare_runtime_incompatibility")
        assert.strictEqual(classified.errorName, "ReferenceError")
        assert.ok(classified.message.includes("document is not defined"))
    })

    // 3. Network timeout classified with bounded retry
    await t.test("3. Network timeout triggers retry and is classified correctly", async () => {
        const logs = []
        const originalWarn = console.warn
        const originalError = console.error
        console.warn = (msg) => {
            if (typeof msg === "string" && msg.startsWith("[youtube-transcript]")) {
                logs.push(JSON.parse(msg.replace("[youtube-transcript] ", "")))
            }
            originalWarn(msg)
        }
        console.error = (msg) => {
            if (typeof msg === "string" && msg.startsWith("[youtube-transcript]")) {
                logs.push(JSON.parse(msg.replace("[youtube-transcript] ", "")))
            }
            originalError(msg)
        }

        try {
            let callCount = 0
            const mockApi = {
                async listTranscripts() {
                    callCount++
                    const err = new Error("The operation was aborted due to timeout")
                    err.name = "TimeoutError"
                    throw err
                },
            }

            const originalFetch = globalThis.fetch
            globalThis.fetch = async (url) => {
                if (String(url).includes("mode=native")) {
                    return new Response(
                        JSON.stringify({
                            content: [{ text: "Fallback segment", offset: 0, duration: 2000 }],
                        }),
                        { status: 200, headers: { "Content-Type": "application/json" } }
                    )
                }
                return originalFetch(url)
            }

            try {
                const requestId = "test_req_timeout_1"
                const result = await extractYouTubeTranscript(
                    "dQw4w9WgXcQ",
                    { SUPADATA_API_KEY: "mock_key" },
                    { lang: "en", transcriptApi: mockApi, requestId }
                )

                // Verifies bounded retry (exactly 2 attempts: attempt 1 + 1 retry)
                assert.strictEqual(callCount, 2)
                assert.strictEqual(result.provider, "supadata")

                const retryLog = logs.find((l) => l.event === "extract_youtube.retry_started")
                assert.ok(retryLog, "Must emit extract_youtube.retry_started")
                assert.strictEqual(retryLog.attempt, 2)
                assert.strictEqual(retryLog.requestId, requestId)

                const failLogs = logs.filter((l) => l.event === "extract_youtube.failed")
                assert.strictEqual(failLogs[0].failureCategory, "timeout")
            } finally {
                globalThis.fetch = originalFetch
            }
        } finally {
            console.warn = originalWarn
            console.error = originalError
        }
    })

    // 4. HTTP 429 rate-limit failure classified as youtube_blocked_or_rate_limited
    await t.test("4. HTTP or rate-limit failure classification", () => {
        const ipBlocked = new IpBlocked("dQw4w9WgXcQ")
        const classified1 = classifyYoutubeError(ipBlocked)
        assert.strictEqual(classified1.category, "youtube_blocked_or_rate_limited")
        assert.strictEqual(classified1.httpStatus, 429)

        const reqBlocked = new RequestBlocked("dQw4w9WgXcQ")
        const classified2 = classifyYoutubeError(reqBlocked)
        assert.strictEqual(classified2.category, "youtube_blocked_or_rate_limited")

        const http403 = new YouTubeRequestFailed("dQw4w9WgXcQ", new Error("HTTP 403: Forbidden"))
        const classified3 = classifyYoutubeError(http403)
        assert.strictEqual(classified3.category, "http_error")
        assert.strictEqual(classified3.httpStatus, 403)
    })

    // 5. Empty transcript validation
    await t.test("5. Empty transcript emits transcript_validation_failed", async () => {
        const logs = []
        const originalError = console.error
        console.error = (msg) => {
            if (typeof msg === "string" && msg.startsWith("[youtube-transcript]")) {
                logs.push(JSON.parse(msg.replace("[youtube-transcript] ", "")))
            }
            originalError(msg)
        }

        try {
            const mockApi = {
                async listTranscripts() {
                    return [
                        createMockTrack({
                            snippets: [], // 0 snippets
                        }),
                    ]
                },
            }

            const res = await fetchCaptionsFromExtractYoutube("dQw4w9WgXcQ", {
                transcriptApi: mockApi,
                requestId: "test_empty_1",
            })

            assert.strictEqual(res.found, false)
            assert.strictEqual(res.failureCategory, "empty_transcript")

            const valLog = logs.find(
                (l) => l.event === "extract_youtube.transcript_validation_failed"
            )
            assert.ok(valLog, "Must emit extract_youtube.transcript_validation_failed")
            assert.strictEqual(valLog.failureCategory, "empty_transcript")
        } finally {
            console.error = originalError
        }
    })

    // 6. Invalid caption/timestamp structure validation
    await t.test("6. Invalid caption/timestamp structure is caught before success", () => {
        // Negative timestamp
        const res1 = validateTranscriptSnippets([
            { text: "Bad cue", start: -5, duration: 2 },
        ])
        assert.strictEqual(res1.valid, false)
        assert.strictEqual(res1.failureCategory, "invalid_timestamps")

        // NaN timestamp
        const res2 = validateTranscriptSnippets([
            { text: "Bad cue", start: "invalid", duration: 2 },
        ])
        assert.strictEqual(res2.valid, false)
        assert.strictEqual(res2.failureCategory, "invalid_timestamps")

        // All whitespace
        const res3 = validateTranscriptSnippets([
            { text: "   ", start: 0, duration: 2 },
            { text: "\n", start: 2, duration: 2 },
        ])
        assert.strictEqual(res3.valid, false)
        assert.strictEqual(res3.failureCategory, "empty_transcript")
    })

    // 7. Unknown exception classification
    await t.test("7. Unknown exception preserves error details safely", () => {
        const weirdErr = { weirdProp: 123, message: "Custom internal failure" }
        const classified = classifyYoutubeError(weirdErr)
        assert.strictEqual(classified.category, "unknown")
        assert.strictEqual(classified.message, "Custom internal failure")
    })

    // 8. Primary failure logged before Supadata fallback begins
    await t.test("8. Primary failure logged before Supadata fallback begins", async () => {
        const eventOrder = []
        const originalLog = console.log
        const originalWarn = console.warn
        const originalError = console.error

        const record = (msg) => {
            if (typeof msg === "string" && msg.startsWith("[youtube-transcript]")) {
                const parsed = JSON.parse(msg.replace("[youtube-transcript] ", ""))
                eventOrder.push(parsed.event)
            }
        }
        console.log = (m) => { record(m); originalLog(m) }
        console.warn = (m) => { record(m); originalWarn(m) }
        console.error = (m) => { record(m); originalError(m) }

        const originalFetch = globalThis.fetch
        globalThis.fetch = async (url) => {
            if (String(url).includes("mode=native")) {
                return new Response(
                    JSON.stringify({
                        content: [{ text: "Fallback text", offset: 0, duration: 1000 }],
                    }),
                    { status: 200, headers: { "Content-Type": "application/json" } }
                )
            }
            return originalFetch(url)
        }

        try {
            const mockApi = {
                async listTranscripts() {
                    throw new VideoUnavailable("dQw4w9WgXcQ")
                },
            }

            const result = await extractYouTubeTranscript(
                "dQw4w9WgXcQ",
                { SUPADATA_API_KEY: "mock_key" },
                { lang: "en", transcriptApi: mockApi, requestId: "test_order_1" }
            )

            assert.strictEqual(result.provider, "supadata")

            const primaryFailIdx = eventOrder.indexOf("extract_youtube.failed")
            const fallbackStartIdx = eventOrder.indexOf("transcript_provider.fallback_started")
            const fallbackCompIdx = eventOrder.indexOf("transcript_provider.fallback_completed")

            assert.ok(primaryFailIdx !== -1, "extract_youtube.failed must be logged")
            assert.ok(fallbackStartIdx !== -1, "transcript_provider.fallback_started must be logged")
            assert.ok(fallbackCompIdx !== -1, "transcript_provider.fallback_completed must be logged")

            // Critical requirement: Primary failure MUST be logged before fallback begins
            assert.ok(
                primaryFailIdx < fallbackStartIdx,
                "extract_youtube.failed must occur BEFORE transcript_provider.fallback_started"
            )
            assert.ok(
                fallbackStartIdx < fallbackCompIdx,
                "transcript_provider.fallback_started must occur BEFORE fallback_completed"
            )
        } finally {
            globalThis.fetch = originalFetch
            console.log = originalLog
            console.warn = originalWarn
            console.error = originalError
        }
    })

    // 9. Supadata success after primary failure returns correlated diagnostic
    await t.test("9. Supadata success after primary failure carries diagnostic event", async () => {
        const originalFetch = globalThis.fetch
        globalThis.fetch = async (url) => {
            if (String(url).includes("mode=native")) {
                return new Response(
                    JSON.stringify({
                        content: [{ text: "Supadata retrieved captions", offset: 0, duration: 1500 }],
                    }),
                    { status: 200, headers: { "Content-Type": "application/json" } }
                )
            }
            return originalFetch(url)
        }

        try {
            const mockApi = {
                async listTranscripts() {
                    throw new NoTranscriptFound("dQw4w9WgXcQ", ["en"], [])
                },
            }

            const requestId = "test_diag_corr_1"
            const result = await extractYouTubeTranscript(
                "dQw4w9WgXcQ",
                { SUPADATA_API_KEY: "mock_key" },
                { lang: "en", transcriptApi: mockApi, requestId }
            )

            assert.strictEqual(result.provider, "supadata")
            assert.ok(result.diagnostic)
            assert.strictEqual(result.diagnostic.requestId, requestId)
            assert.strictEqual(result.diagnostic.failureCategory, "captions_unavailable")
            assert.strictEqual(result.diagnostic.provider, "extract-youtube")
            assert.ok(result.diagnostic.message.includes("Primary provider failed"))
        } finally {
            globalThis.fetch = originalFetch
        }
    })

    // 10. Browser diagnostics are sanitized and correlated
    await t.test("10. Diagnostic events are sanitized and contain no internal secrets", () => {
        const sanitized = sanitizeStructuredLog({
            event: "extract_youtube.failed",
            requestId: "req_secret_test",
            errorMessage: "Unauthorized request with key=supa_secret_abc123 and bearer sensitive_tok_xyz",
            errorCause: "Failed at https://api.supadata.ai/v1/youtube/transcript?api_key=supa_secret_abc123",
            urlTarget: "https://www.youtube.com/youtubei/v1/player?key=AIzaSyD-secret_key_here",
            stack: "Error: at /secret/path/to/server.ts:123",
        })

        assert.ok(!sanitized.errorMessage.includes("supa_secret_abc123"))
        assert.ok(!sanitized.errorMessage.includes("sensitive_tok_xyz"))
        assert.ok(sanitized.errorMessage.includes("[REDACTED]"))

        assert.ok(!sanitized.errorCause.includes("supa_secret_abc123"))
        assert.ok(sanitized.errorCause.includes("[REDACTED]"))

        // URL query parameter stripped
        assert.strictEqual(sanitized.urlTarget, "https://www.youtube.com/youtubei/v1/player")
    })

    // 11. Optional diagnostic mode (disableFallback) works safely
    await t.test("11. Optional diagnostic mode disableFallback prevents Supadata calls", async () => {
        let supadataCalled = false
        const originalFetch = globalThis.fetch
        globalThis.fetch = async (url) => {
            if (String(url).includes("mode=native")) {
                supadataCalled = true
                return new Response("OK", { status: 200 })
            }
            return originalFetch(url)
        }

        try {
            const mockApi = {
                async listTranscripts() {
                    throw new NoTranscriptFound("dQw4w9WgXcQ", ["en"], [])
                },
            }

            const result = await extractYouTubeTranscript(
                "dQw4w9WgXcQ",
                { SUPADATA_API_KEY: "mock_key" },
                {
                    lang: "en",
                    transcriptApi: mockApi,
                    disableFallback: true, // Controlled diagnostic mode
                }
            )

            assert.strictEqual(result.transcript, null)
            assert.strictEqual(result.needsConfirmation, true)
            assert.strictEqual(supadataCalled, false, "Must not invoke Supadata when fallback is disabled")
            assert.ok(result.message.includes("fallback is disabled"))
            assert.strictEqual(result.diagnostic?.failureCategory, "captions_unavailable")
        } finally {
            globalThis.fetch = originalFetch
        }
    })

    // 12. Correlation ID generation & execution runtime detection
    await t.test("12. Correlation ID generation and runtime detection", () => {
        const id1 = generateCorrelationId()
        const id2 = generateCorrelationId()
        assert.notStrictEqual(id1, id2)
        assert.ok(id1.startsWith("yt_"))

        const runtime = detectExecutionRuntime()
        assert.ok(typeof runtime === "string" && runtime.length > 0)
    })

    // 13. YouTube /youtubei/v1/player playabilityStatus and reason logging on failure
    await t.test("13. YouTube /youtubei/v1/player playabilityStatus and reason logging on failure", async () => {
        const logs = []
        const originalError = console.error
        console.error = (msg) => {
            if (typeof msg === "string" && msg.startsWith("[youtube-transcript]")) {
                logs.push(JSON.parse(msg.replace("[youtube-transcript] ", "")))
            }
            originalError(msg)
        }

        const originalFetch = globalThis.fetch
        // Mock global fetch to intercept /youtubei/v1/player
        globalThis.fetch = async (url, options) => {
            const urlStr = String(url)
            if (urlStr.includes("/youtubei/v1/player")) {
                return new Response(
                    JSON.stringify({
                        playabilityStatus: {
                            status: "LOGIN_REQUIRED",
                            reason: "Sign in to confirm you're not a bot",
                        },
                    }),
                    {
                        status: 200,
                        headers: { "Content-Type": "application/json" },
                    }
                )
            }
            return originalFetch(url, options)
        }

        try {
            const requestId = "test_player_playability_1"
            const result = await fetchCaptionsFromExtractYoutube("dQw4w9WgXcQ", {
                requestId,
            })

            assert.strictEqual(result.found, false)
            assert.strictEqual(result.playabilityStatus, "LOGIN_REQUIRED")
            assert.strictEqual(result.playabilityReason, "Sign in to confirm you're not a bot")

            const failedLog = logs.find((l) => l.event === "extract_youtube.failed" && l.requestId === requestId)
            assert.ok(failedLog, "Must emit extract_youtube.failed")
            assert.strictEqual(failedLog.playabilityStatus, "LOGIN_REQUIRED")
            assert.strictEqual(failedLog.playabilityReason, "Sign in to confirm you're not a bot")
            assert.strictEqual(failedLog.failureCategory, "youtube_blocked_or_rate_limited")
        } finally {
            globalThis.fetch = originalFetch
            console.error = originalError
        }
    })

    // 14. Playability reason secret sanitization & Supadata fallback preservation
    await t.test("14. Playability reason secret sanitization and Supadata fallback preservation", async () => {
        const logs = []
        const originalLog = console.log
        const originalWarn = console.warn
        const originalError = console.error

        console.log = (m) => {
            if (typeof m === "string" && m.startsWith("[youtube-transcript]")) {
                logs.push(JSON.parse(m.replace("[youtube-transcript] ", "")))
            }
            originalLog(m)
        }
        console.warn = (m) => {
            if (typeof m === "string" && m.startsWith("[youtube-transcript]")) {
                logs.push(JSON.parse(m.replace("[youtube-transcript] ", "")))
            }
            originalWarn(m)
        }
        console.error = (m) => {
            if (typeof m === "string" && m.startsWith("[youtube-transcript]")) {
                logs.push(JSON.parse(m.replace("[youtube-transcript] ", "")))
            }
            originalError(m)
        }

        const originalFetch = globalThis.fetch
        globalThis.fetch = async (url, options) => {
            const urlStr = String(url)
            if (urlStr.includes("/youtubei/v1/player")) {
                return new Response(
                    JSON.stringify({
                        playabilityStatus: {
                            status: "ERROR",
                            reason: "Video blocked with key=AIzaSySecretApiKey123 and bearer sensitive_token",
                        },
                    }),
                    {
                        status: 200,
                        headers: { "Content-Type": "application/json" },
                    }
                )
            }
            if (urlStr.includes("mode=native")) {
                return new Response(
                    JSON.stringify({
                        content: [{ text: "Supadata retrieved captions", offset: 0, duration: 1000 }],
                    }),
                    {
                        status: 200,
                        headers: { "Content-Type": "application/json" },
                    }
                )
            }
            return originalFetch(url, options)
        }

        try {
            const requestId = "test_player_sanitize_1"
            const result = await extractYouTubeTranscript(
                "dQw4w9WgXcQ",
                { SUPADATA_API_KEY: "mock_key" },
                { requestId }
            )

            // Supadata fallback is preserved and succeeded
            assert.strictEqual(result.provider, "supadata")
            assert.strictEqual(result.transcript.segments.length, 1)

            const failLog = logs.find((l) => l.event === "extract_youtube.failed" && l.requestId === requestId)
            assert.ok(failLog, "Must emit extract_youtube.failed")
            assert.strictEqual(failLog.playabilityStatus, "ERROR")
            assert.ok(!failLog.playabilityReason.includes("AIzaSySecretApiKey123"))
            assert.ok(!failLog.playabilityReason.includes("sensitive_token"))
            assert.ok(failLog.playabilityReason.includes("[REDACTED]"))
        } finally {
            globalThis.fetch = originalFetch
            console.log = originalLog
            console.warn = originalWarn
            console.error = originalError
        }
    })
})
