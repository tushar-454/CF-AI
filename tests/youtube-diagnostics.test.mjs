/**
 * Dedicated test suite for YouTube Caption Extractor Diagnostics, Structured Logging,
 * Error Classification, and ScrapingBee Subtitles Telemetry.
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
    fetchSubtitlesFromScrapingBee,
    normalizeScrapingBeeSubtitles,
    parseScrapingBeeSubtitles,
} from "../src/lib/youtube-extractor.ts"

function createMockScrapingBeeSubtitles({
    language = "en",
    subtitle_origin = "uploader_provided",
    subtitles = [
        { text: "Hello and welcome to this video.", start: 0, duration: 3.5 },
        { text: "Today we explore edge computing.", start: 3.5, duration: 4.0 },
    ],
} = {}) {
    return {
        video_id: "dQw4w9WgXcQ",
        language,
        subtitle_origin,
        subtitles,
    }
}

test("YouTube Caption Diagnostics and Logging Suite", async (t) => {
    // 1. Successful ScrapingBee extraction emits structured logs and doesn't call fallback
    await t.test("1. Successful ScrapingBee extraction emits structured logs", async () => {
        const logs = []
        const originalLog = console.log
        console.log = (msg) => {
            if (typeof msg === "string" && msg.startsWith("[youtube-transcript]")) {
                logs.push(JSON.parse(msg.replace("[youtube-transcript] ", "")))
            }
            originalLog(msg)
        }

        try {
            const mockFetch = async (url, options) => {
                assert.ok(String(url).includes("video_id=dQw4w9WgXcQ"))
                assert.strictEqual(options?.headers?.Authorization, "Bearer mock_scrapingbee_key")
                return new Response(JSON.stringify(createMockScrapingBeeSubtitles()), {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                })
            }

            const requestId = "test_req_success_1"
            const result = await extractYouTubeTranscript(
                "dQw4w9WgXcQ",
                { SCRAPINGBEE_API_KEY: "mock_scrapingbee_key" },
                { lang: "en", fetchFn: mockFetch, requestId }
            )

            assert.strictEqual(result.needsConfirmation, false)
            assert.strictEqual(result.provider, "scrapingbee")
            assert.strictEqual(result.transcript.segments.length, 2)
            assert.strictEqual(result.transcript.provider, "scrapingbee")

            const events = logs.map((l) => l.event)
            assert.ok(events.includes("scrapingbee.started"))
            assert.ok(events.includes("scrapingbee.video_id_validated"))
            assert.ok(events.includes("scrapingbee.request_started"))
            assert.ok(events.includes("scrapingbee.response_received"))
            assert.ok(events.includes("scrapingbee.transcript_received"))
            assert.ok(events.includes("scrapingbee.completed"))
            assert.ok(!events.includes("transcript_provider.fallback_started"))

            const completed = logs.find((l) => l.event === "scrapingbee.completed")
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

    // 3. Network timeout triggers bounded retry and is classified correctly
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
            const mockFetch = async () => {
                callCount++
                const err = new Error("The operation was aborted due to timeout")
                err.name = "TimeoutError"
                throw err
            }

            const requestId = "test_req_timeout_1"
            const result = await extractYouTubeTranscript(
                "dQw4w9WgXcQ",
                { SCRAPINGBEE_API_KEY: "mock_scrapingbee_key" },
                { lang: "en", fetchFn: mockFetch, requestId }
            )

            // Verifies bounded retry (exactly 2 attempts: attempt 1 + 1 retry)
            assert.strictEqual(callCount, 2)
            assert.strictEqual(result.transcript, null)
            assert.strictEqual(result.provider, null)

            const retryLog = logs.find((l) => l.event === "scrapingbee.retry_started")
            assert.ok(retryLog, "Must emit scrapingbee.retry_started")
            assert.strictEqual(retryLog.attempt, 2)
            assert.strictEqual(retryLog.requestId, requestId)

            const failLogs = logs.filter((l) => l.event === "scrapingbee.failed")
            assert.strictEqual(failLogs[0].failureCategory, "timeout")
        } finally {
            console.warn = originalWarn
            console.error = originalError
        }
    })

    // 4. HTTP status code classifications (401, 403, 429)
    await t.test("4. HTTP or rate-limit failure classification", () => {
        const classified401 = classifyYoutubeError(new Error("Unauthorized request"), {
            httpStatus: 401,
        })
        assert.strictEqual(classified401.httpStatus, 401)
        assert.ok(classified401.message.includes("Invalid ScrapingBee API key"))

        const classified403 = classifyYoutubeError(new Error("Credit limit reached"), {
            httpStatus: 403,
        })
        assert.strictEqual(classified403.httpStatus, 403)
        assert.ok(classified403.message.includes("ScrapingBee credit limit exceeded"))

        const classified429 = classifyYoutubeError(new Error("Too many requests"), {
            httpStatus: 429,
        })
        assert.strictEqual(classified429.category, "youtube_blocked_or_rate_limited")
        assert.strictEqual(classified429.httpStatus, 429)
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
            const mockFetch = async () => {
                return new Response(JSON.stringify({ subtitles: [] }), {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                })
            }

            const res = await fetchSubtitlesFromScrapingBee("dQw4w9WgXcQ", "mock_key", {
                fetchFn: mockFetch,
                requestId: "test_empty_1",
            })

            assert.strictEqual(res.found, false)
            assert.strictEqual(res.failureCategory, "empty_transcript")

            const valLog = logs.find((l) => l.event === "scrapingbee.transcript_validation_failed")
            assert.ok(valLog, "Must emit scrapingbee.transcript_validation_failed")
            assert.strictEqual(valLog.failureCategory, "empty_transcript")
        } finally {
            console.error = originalError
        }
    })

    // 6. Invalid caption/timestamp structure validation
    await t.test("6. Invalid caption/timestamp structure is caught before success", () => {
        // Negative timestamp
        const res1 = validateTranscriptSnippets([{ text: "Bad cue", start: -5, duration: 2 }])
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

    // 8. ScrapingBee failure does NOT call Supadata fallback
    await t.test("8. ScrapingBee failure does not invoke Supadata fallback", async () => {
        let supadataCalled = false
        const originalFetch = globalThis.fetch
        globalThis.fetch = async (url) => {
            if (String(url).includes("api.supadata.ai")) {
                supadataCalled = true
                throw new Error("Supadata MUST NOT be called!")
            }
            return originalFetch(url)
        }

        try {
            const mockFetch = async () => {
                return new Response("Not Found", { status: 404 })
            }

            const result = await extractYouTubeTranscript(
                "dQw4w9WgXcQ",
                { SCRAPINGBEE_API_KEY: "mock_key", SUPADATA_API_KEY: "mock_supadata_key" },
                { lang: "en", fetchFn: mockFetch, requestId: "test_no_fallback_1" }
            )

            assert.strictEqual(result.transcript, null)
            assert.strictEqual(result.provider, null)
            assert.strictEqual(
                supadataCalled,
                false,
                "Supadata must not be called when ScrapingBee fails"
            )
            assert.strictEqual(result.diagnostic?.failureCategory, "captions_unavailable")
        } finally {
            globalThis.fetch = originalFetch
        }
    })

    // 9. ScrapingBee 404 cleanly classifies as captions_unavailable
    await t.test("9. ScrapingBee 404 cleanly classifies as captions_unavailable", async () => {
        const mockFetch = async () => {
            return new Response("No subtitles found", { status: 404 })
        }

        const requestId = "test_404_1"
        const result = await extractYouTubeTranscript(
            "dQw4w9WgXcQ",
            { SCRAPINGBEE_API_KEY: "mock_key" },
            { lang: "en", fetchFn: mockFetch, requestId }
        )

        assert.strictEqual(result.transcript, null)
        assert.strictEqual(result.provider, null)
        assert.strictEqual(result.diagnostic?.failureCategory, "captions_unavailable")
        assert.ok(result.message.includes("Captions are unavailable"))
    })

    // 10. Diagnostic events are sanitized and contain no internal secrets
    await t.test("10. Diagnostic events are sanitized and contain no internal secrets", () => {
        const sanitized = sanitizeStructuredLog({
            event: "scrapingbee.failed",
            requestId: "req_secret_test",
            errorMessage:
                "Unauthorized request with key=scrapingbee_secret_abc123 and bearer sensitive_tok_xyz",
            errorCause: "Failed with api_key=scrapingbee_secret_abc123",
            urlTarget:
                "https://app.scrapingbee.com/api/v1/youtube/subtitles?api_key=secret_in_url&video_id=dQw4w9WgXcQ",
            stack: "Error: at /secret/path/to/server.ts:123",
        })

        assert.ok(!sanitized.errorMessage.includes("scrapingbee_secret_abc123"))
        assert.ok(!sanitized.errorMessage.includes("sensitive_tok_xyz"))
        assert.ok(sanitized.errorMessage.includes("[REDACTED]"))

        assert.ok(!sanitized.errorCause.includes("scrapingbee_secret_abc123"))
        assert.ok(sanitized.errorCause.includes("[REDACTED]"))

        // URL query parameter stripped
        assert.ok(!sanitized.urlTarget.includes("secret_in_url"))
        assert.ok(sanitized.urlTarget.includes("[REDACTED]"))
    })

    // 11. Missing SCRAPINGBEE_API_KEY produces clear diagnostic without calling network
    await t.test("11. Missing SCRAPINGBEE_API_KEY fails immediately with clear error", async () => {
        let networkCalled = false
        const mockFetch = async () => {
            networkCalled = true
            return new Response("OK", { status: 200 })
        }

        const result = await extractYouTubeTranscript(
            "dQw4w9WgXcQ",
            {}, // No SCRAPINGBEE_API_KEY provided
            { fetchFn: mockFetch }
        )

        assert.strictEqual(result.transcript, null)
        assert.strictEqual(result.provider, null)
        assert.strictEqual(networkCalled, false, "Must not make network request without API key")
        assert.ok(result.message.includes("SCRAPINGBEE_API_KEY is not configured"))
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

    // 13. ScrapingBee 500 error classification and retry
    await t.test("13. ScrapingBee 500 server error triggers bounded retry", async () => {
        let callCount = 0
        const mockFetch = async () => {
            callCount++
            return new Response("Internal Server Error", { status: 500 })
        }

        const result = await extractYouTubeTranscript(
            "dQw4w9WgXcQ",
            { SCRAPINGBEE_API_KEY: "mock_key" },
            { fetchFn: mockFetch }
        )

        assert.strictEqual(callCount, 2, "Must retry exactly once on 500 server error")
        assert.strictEqual(result.transcript, null)
        assert.strictEqual(result.diagnostic?.failureCategory, "http_error")
    })

    // 14. Normalization converts seconds and handles both array and wrapped response formats
    await t.test("14. Normalizer converts seconds accurately and sets scrapingbee provider", () => {
        const rawCues = [
            { text: "  First caption line  ", start: 1.25, duration: 2.5 },
            { text: "Second caption line", start: "3.75", duration: "1.5" },
        ]

        const norm = normalizeScrapingBeeSubtitles(rawCues, "dQw4w9WgXcQ", "en")
        assert.strictEqual(norm.provider, "scrapingbee")
        assert.strictEqual(norm.source, "native")
        assert.strictEqual(norm.segments.length, 2)
        assert.strictEqual(norm.segments[0].text, "First caption line")
        assert.strictEqual(norm.segments[0].startSeconds, 1.25)
        assert.strictEqual(norm.segments[0].endSeconds, 3.75)
        assert.strictEqual(norm.segments[1].startSeconds, 3.75)
        assert.strictEqual(norm.segments[1].endSeconds, 5.25)
        assert.strictEqual(norm.duration, 6)
    })

    // 15. ScrapingBee real nested schema parsing with ms timestamps and snippet runs
    await t.test(
        "15. parseScrapingBeeSubtitles handles real YouTube nested schema, snippet runs, and ms times",
        () => {
            const realScrapingBeePayload = {
                subtitles: {
                    auto_generated: {
                        en: [
                            {
                                d_duration_ms: "2000",
                                snippet: { runs: [{ text: "Auto" }, { text: " generated line" }] },
                                start_ms: "100",
                            },
                        ],
                    },
                    uploader_provided: {
                        en: [
                            {
                                d_duration_ms: "3650",
                                snippet: {
                                    runs: [
                                        {
                                            text: "Hi everyone, I'm Anson Alexander\nand welcome to my beginners tutorial for",
                                        },
                                    ],
                                },
                                start_ms: "350",
                            },
                            {
                                d_duration_ms: "1999",
                                snippet: {
                                    runs: [{ text: "using macOS." }],
                                },
                                start_ms: "4001",
                            },
                        ],
                    },
                },
            }

            // By default, prefers uploader_provided over auto_generated
            const parsed = parseScrapingBeeSubtitles(realScrapingBeePayload, { lang: "en" })
            assert.strictEqual(parsed.language, "en")
            assert.strictEqual(parsed.isGenerated, false)
            assert.strictEqual(parsed.origin, "uploader_provided")
            assert.ok(parsed.cues)
            assert.strictEqual(parsed.cues.length, 2)
            assert.strictEqual(
                parsed.cues[0].text,
                "Hi everyone, I'm Anson Alexander and welcome to my beginners tutorial for"
            )
            assert.strictEqual(parsed.cues[0].start, 0.35)
            assert.strictEqual(parsed.cues[0].duration, 3.65)
            assert.strictEqual(parsed.cues[1].text, "using macOS.")
            assert.strictEqual(parsed.cues[1].start, 4)
            assert.strictEqual(parsed.cues[1].duration, 2)

            // When options.subtitleOrigin is auto_generated, prefers auto_generated
            const parsedAuto = parseScrapingBeeSubtitles(realScrapingBeePayload, {
                lang: "en",
                subtitleOrigin: "auto_generated",
            })
            assert.strictEqual(parsedAuto.isGenerated, true)
            assert.strictEqual(parsedAuto.origin, "auto_generated")
            assert.ok(parsedAuto.cues)
            assert.strictEqual(parsedAuto.cues.length, 1)
            assert.strictEqual(parsedAuto.cues[0].text, "Auto generated line")
            assert.strictEqual(parsedAuto.cues[0].start, 0.1)
            assert.strictEqual(parsedAuto.cues[0].duration, 2)
        }
    )

    // 16. extractYouTubeTranscript end-to-end with real ScrapingBee nested response
    await t.test(
        "16. extractYouTubeTranscript extracts and normalizes real ScrapingBee nested subtitles response",
        async () => {
            const realScrapingBeePayload = {
                subtitles: {
                    uploader_provided: {
                        en: [
                            {
                                d_duration_ms: "3650",
                                snippet: {
                                    runs: [{ text: "Welcome to this tutorial." }],
                                },
                                start_ms: "350",
                            },
                        ],
                    },
                },
            }

            const mockFetch = async () => {
                return new Response(JSON.stringify(realScrapingBeePayload), {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                })
            }

            const result = await extractYouTubeTranscript(
                "dQw4w9WgXcQ",
                { SCRAPINGBEE_API_KEY: "mock_key" },
                { fetchFn: mockFetch, lang: "en" }
            )

            assert.strictEqual(result.needsConfirmation, false)
            assert.ok(result.transcript)
            assert.strictEqual(result.transcript.provider, "scrapingbee")
            assert.strictEqual(result.transcript.segments.length, 1)
            assert.strictEqual(result.transcript.segments[0].text, "Welcome to this tutorial.")
            assert.strictEqual(result.transcript.segments[0].startSeconds, 0.35)
            assert.strictEqual(result.transcript.segments[0].endSeconds, 4)
        }
    )
})
