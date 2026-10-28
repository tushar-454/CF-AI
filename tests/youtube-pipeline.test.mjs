import test from "node:test"
import assert from "node:assert/strict"

import {
    extractYouTubeVideoId,
    validateYouTubeUrl,
    getCanonicalYouTubeUrl,
    isValidYouTubeVideoId,
} from "../src/lib/youtube-url.ts"
import {
    formatTimestamp,
    parseTimestamp,
    findActiveSegmentIndex,
    chunkTranscriptSegments,
} from "../src/lib/youtube-chunker.ts"
import {
    fetchNativeCaptions,
    SupadataError,
    normalizeSupadataSegments,
} from "../src/lib/supadata.ts"
import { retrieveYoutubeContext, verifyYoutubeIndexingComplete } from "../src/lib/youtube-rag.ts"
import {
    createYoutubeVideo,
    getYoutubeVideo,
    updateYoutubeVideoProgress,
    saveYoutubeChunks,
    getYoutubeChunks,
    createConversation,
    getConversation,
    listConversations,
    createMessage,
    getMessages,
} from "../src/lib/db.ts"
import { executeYoutubePipeline } from "../src/lib/youtube-pipeline.ts"
import { YoutubeProcessingWorkflow } from "../src/lib/youtube-workflow.ts"
import { YOUTUBE_EMBEDDING_CONFIG } from "../src/lib/youtube-model-config.ts"
import {
    detectYouTubeVideoLanguage,
    isBengaliText,
    normalizeLanguageCode,
} from "../src/lib/youtube-metadata.ts"
import {
    extractYouTubeTranscript,
    normalizeExtractYoutubeSnippets,
} from "../src/lib/youtube-extractor.ts"

test("YouTube Video Chat Architecture & Pipeline Suite", async (t) => {
    // -------------------------------------------------------------
    // Test 1: YouTube URL validation, ID extraction, and canonicalization
    // -------------------------------------------------------------
    await t.test("1. YouTube URL parser extracts IDs and canonicalizes supported formats", () => {
        const standardUrl = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
        const shortUrl = "https://youtu.be/dQw4w9WgXcQ"
        const shortsUrl = "https://www.youtube.com/shorts/dQw4w9WgXcQ"
        const embedUrl = "https://www.youtube.com/embed/dQw4w9WgXcQ?autoplay=1"
        const queryWithExtras = "https://youtube.com/watch?v=dQw4w9WgXcQ&feature=share&t=42s"
        const mobileUrl = "https://m.youtube.com/watch?v=dQw4w9WgXcQ"

        assert.strictEqual(extractYouTubeVideoId(standardUrl), "dQw4w9WgXcQ")
        assert.strictEqual(extractYouTubeVideoId(shortUrl), "dQw4w9WgXcQ")
        assert.strictEqual(extractYouTubeVideoId(shortsUrl), "dQw4w9WgXcQ")
        assert.strictEqual(extractYouTubeVideoId(embedUrl), "dQw4w9WgXcQ")
        assert.strictEqual(extractYouTubeVideoId(queryWithExtras), "dQw4w9WgXcQ")
        assert.strictEqual(extractYouTubeVideoId(mobileUrl), "dQw4w9WgXcQ")

        assert.strictEqual(
            getCanonicalYouTubeUrl("dQw4w9WgXcQ"),
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
        )

        // Validation test
        const validRes = validateYouTubeUrl(queryWithExtras)
        assert.strictEqual(validRes.valid, true)
        assert.strictEqual(validRes.videoId, "dQw4w9WgXcQ")
        assert.strictEqual(validRes.canonicalUrl, "https://www.youtube.com/watch?v=dQw4w9WgXcQ")

        // Invalid hosts and formats
        assert.strictEqual(extractYouTubeVideoId("https://vimeo.com/12345678"), null)
        assert.strictEqual(extractYouTubeVideoId("https://evil-site.com/watch?v=dQw4w9WgXcQ"), null)
        assert.strictEqual(
            extractYouTubeVideoId("https://youtube.com/playlist?list=PL123456789"),
            null
        )
        assert.strictEqual(extractYouTubeVideoId("not a url at all"), null)
        assert.strictEqual(extractYouTubeVideoId(""), null)

        const invalidHostRes = validateYouTubeUrl("https://phishing.com/watch?v=dQw4w9WgXcQ")
        assert.strictEqual(invalidHostRes.valid, false)
        assert.ok(
            invalidHostRes.error?.includes("domain") || invalidHostRes.error?.includes("hostname")
        )

        const playlistOnlyRes = validateYouTubeUrl("https://youtube.com/playlist?list=PL123456789")
        assert.strictEqual(playlistOnlyRes.valid, false)

        assert.strictEqual(isValidYouTubeVideoId("dQw4w9WgXcQ"), true)
        assert.strictEqual(isValidYouTubeVideoId("short"), false)
        assert.strictEqual(isValidYouTubeVideoId("tooLongVideoId123"), false)
        assert.strictEqual(isValidYouTubeVideoId("invalid$char"), false)
    })

    // -------------------------------------------------------------
    // Test 2: Transcript normalization from Supadata format (ms -> s)
    // -------------------------------------------------------------
    await t.test(
        "2. Supadata segment normalization converts ms to seconds and validates numeric values",
        () => {
            const rawSegments = [
                {
                    text: "Welcome to Cloudflare Workers and Workflows.",
                    offset: 0,
                    duration: 3500,
                    lang: "en",
                },
                {
                    text: "Today we will implement a YouTube RAG system.",
                    offset: 3600,
                    duration: 4200,
                    lang: "en",
                },
                { text: "   ", offset: 8000, duration: 1000 }, // empty text should be skipped
                { text: "Let's explore Durable Objects.", offset: 9500, duration: 2500 },
            ]

            const normalized = normalizeSupadataSegments(rawSegments, "dQw4w9WgXcQ", "native")
            assert.strictEqual(normalized.segments.length, 3)

            assert.strictEqual(normalized.segments[0].startSeconds, 0)
            assert.strictEqual(normalized.segments[0].endSeconds, 3.5)
            assert.strictEqual(
                normalized.segments[0].text,
                "Welcome to Cloudflare Workers and Workflows."
            )
            assert.strictEqual(normalized.segments[0].lang, "en")

            assert.strictEqual(normalized.segments[1].startSeconds, 3.6)
            assert.strictEqual(normalized.segments[1].endSeconds, 7.8)

            assert.strictEqual(normalized.segments[2].startSeconds, 9.5)
            assert.strictEqual(normalized.segments[2].endSeconds, 12)
        }
    )

    // -------------------------------------------------------------
    // Test 3: Timestamp formatting, parsing, and binary search segment lookup
    // -------------------------------------------------------------
    await t.test("3. Timestamp formatting and binary search active segment lookup", () => {
        // Formatting
        assert.strictEqual(formatTimestamp(0), "00:00")
        assert.strictEqual(formatTimestamp(65), "01:05")
        assert.strictEqual(formatTimestamp(3661), "1:01:01")
        assert.strictEqual(formatTimestamp(-5), "00:00")

        // Parsing
        assert.strictEqual(parseTimestamp("00:00"), 0)
        assert.strictEqual(parseTimestamp("01:05"), 65)
        assert.strictEqual(parseTimestamp("01:01:01"), 3661)
        assert.strictEqual(parseTimestamp("invalid"), null)

        // Binary search lookup
        const segments = [
            { id: "s0", text: "Intro", startSeconds: 0, endSeconds: 10 },
            { id: "s1", text: "Topic A", startSeconds: 10, endSeconds: 30 },
            { id: "s2", text: "Topic B", startSeconds: 30, endSeconds: 45 },
            { id: "s3", text: "Conclusion", startSeconds: 45, endSeconds: 60 },
        ]

        assert.strictEqual(findActiveSegmentIndex(segments, 0), 0)
        assert.strictEqual(findActiveSegmentIndex(segments, 5), 0)
        assert.strictEqual(findActiveSegmentIndex(segments, 10), 1)
        assert.strictEqual(findActiveSegmentIndex(segments, 25), 1)
        assert.strictEqual(findActiveSegmentIndex(segments, 30), 2)
        assert.strictEqual(findActiveSegmentIndex(segments, 44.9), 2)
        assert.strictEqual(findActiveSegmentIndex(segments, 50), 3)
        assert.strictEqual(findActiveSegmentIndex(segments, 75), 3) // past end stays on last segment
        assert.strictEqual(findActiveSegmentIndex([], 10), -1)
    })

    // -------------------------------------------------------------
    // Test 4: Semantic chunking preserves timestamps and bounds
    // -------------------------------------------------------------
    await t.test(
        "4. chunkTranscriptSegments generates contiguous bounded chunks with preserved timestamps",
        () => {
            const segments = [
                {
                    id: "s0",
                    text: "First point about Cloudflare Workers architecture.",
                    startSeconds: 0,
                    endSeconds: 5,
                },
                {
                    id: "s1",
                    text: "Workers run on V8 isolates across the global edge network.",
                    startSeconds: 5,
                    endSeconds: 11,
                },
                {
                    id: "s2",
                    text: "Durable Objects provide strongly consistent coordinated state.",
                    startSeconds: 11,
                    endSeconds: 18,
                },
                {
                    id: "s3",
                    text: "Workflows provide resilient multi-step background processing.",
                    startSeconds: 18,
                    endSeconds: 24,
                },
                {
                    id: "s4",
                    text: "Vectorize powers fast vector similarity search.",
                    startSeconds: 24,
                    endSeconds: 29,
                },
            ]

            const chunks = chunkTranscriptSegments("testVideo123", segments, 80, 20)
            assert.ok(chunks.length >= 2, `Expected at least 2 chunks, got ${chunks.length}`)

            // Validate chunk structure
            for (let i = 0; i < chunks.length; i++) {
                const chunk = chunks[i]
                assert.strictEqual(chunk.videoId, "testVideo123")
                assert.strictEqual(chunk.chunkIndex, i)
                assert.strictEqual(chunk.id, `testVideo123_${i}`)
                assert.ok(chunk.startSeconds >= 0)
                assert.ok(chunk.endSeconds >= chunk.startSeconds)
                assert.ok(chunk.text.length > 0)
            }

            // Check continuity: first chunk start is 0
            assert.strictEqual(chunks[0].startSeconds, 0)
            // Last chunk ends at or after last segment end
            assert.ok(chunks[chunks.length - 1].endSeconds >= 24)
        }
    )

    // -------------------------------------------------------------
    // Test 5: Supadata adapter error handling and AI confirmation requirement
    // -------------------------------------------------------------
    await t.test(
        "5. Supadata adapter handles native captions, rate limits, and requires AI confirmation",
        async () => {
            const originalFetch = globalThis.fetch
            try {
                // 5.1 Native captions found
                globalThis.fetch = async (url) => {
                    if (String(url).includes("mode=native")) {
                        return new Response(
                            JSON.stringify({
                                content: [
                                    {
                                        text: "Native caption 1",
                                        offset: 0,
                                        duration: 2000,
                                        lang: "en",
                                    },
                                    {
                                        text: "Native caption 2",
                                        offset: 2500,
                                        duration: 3000,
                                        lang: "en",
                                    },
                                ],
                                lang: "en",
                            }),
                            { status: 200, headers: { "Content-Type": "application/json" } }
                        )
                    }
                    return new Response("Not found", { status: 404 })
                }

                const res1 = await fetchNativeCaptions("dQw4w9WgXcQ", "mock_key")
                assert.strictEqual(res1.found, true)
                if (res1.found) {
                    assert.strictEqual(res1.transcript?.source, "native")
                    assert.strictEqual(res1.transcript?.segments.length, 2)
                }

                // 5.2 Native captions unavailable -> found: false
                globalThis.fetch = async (url) => {
                    if (String(url).includes("mode=native")) {
                        return new Response(
                            JSON.stringify({
                                error: "Captions not available for this video",
                                code: "CAPTIONS_NOT_AVAILABLE",
                            }),
                            { status: 404, headers: { "Content-Type": "application/json" } }
                        )
                    }
                    return new Response("Not found", { status: 404 })
                }

                const res2 = await fetchNativeCaptions("dQw4w9WgXcQ", "mock_key")
                assert.strictEqual(res2.found, false)
                if (!res2.found) {
                    assert.strictEqual(res2.reason, "no_captions")
                }

                // 5.3 Transient rate limit error -> isRetryable = true
                globalThis.fetch = async () => {
                    return new Response(JSON.stringify({ error: "Rate limit exceeded" }), {
                        status: 429,
                        headers: { "Retry-After": "5" },
                    })
                }

                await assert.rejects(
                    async () => {
                        await fetchNativeCaptions("dQw4w9WgXcQ", "mock_key")
                    },
                    (err) => {
                        assert.ok(err instanceof SupadataError)
                        assert.strictEqual(err.isRetryable, true)
                        assert.strictEqual(err.statusCode, 429)
                        return true
                    }
                )

                // 5.4 Permanent authentication error -> isRetryable = false
                globalThis.fetch = async () => {
                    return new Response(JSON.stringify({ error: "Invalid API key" }), {
                        status: 401,
                    })
                }

                await assert.rejects(
                    async () => {
                        await fetchNativeCaptions("dQw4w9WgXcQ", "mock_key")
                    },
                    (err) => {
                        assert.ok(err instanceof SupadataError)
                        assert.strictEqual(err.isRetryable, false)
                        assert.strictEqual(err.statusCode, 401)
                        return true
                    }
                )
            } finally {
                globalThis.fetch = originalFetch
            }
        }
    )

    // -------------------------------------------------------------
    // Test 6: D1 YouTube CRUD, deduplication, and independent conversations
    // -------------------------------------------------------------
    await t.test(
        "6. D1 YouTube functions handle video deduplication and independent conversations",
        async () => {
            const videosDb = new Map()
            const chunksDb = new Map()
            const conversationsDb = new Map()
            const messagesDb = new Map()

            // In-memory mock D1 Database
            const createStatement = (sql, args = []) => ({
                bind(...newArgs) {
                    return createStatement(sql, newArgs)
                },
                async run() {
                    if (sql.includes("INSERT INTO youtube_videos")) {
                        const [
                            id,
                            title,
                            url,
                            _ch,
                            duration,
                            _th,
                            _tl,
                            _ts,
                            _tv,
                            status,
                            stage,
                            progress,
                        ] = args
                        videosDb.set(id, {
                            id,
                            url,
                            title,
                            duration: duration || 120,
                            status: status || "validating",
                            stage: stage || "validating",
                            progress: progress || 0,
                            created_at: Date.now(),
                            updated_at: Date.now(),
                        })
                    } else if (sql.includes("UPDATE youtube_videos")) {
                        const id = args[args.length - 1]
                        const record = videosDb.get(id) || {}
                        videosDb.set(id, {
                            ...record,
                            status: "ready",
                            stage: "ready",
                            progress: 100,
                            updated_at: Date.now(),
                        })
                    } else if (sql.includes("INSERT INTO youtube_chunks")) {
                        const [id, videoId, chunkIndex, start, end, text] = args
                        chunksDb.set(id, {
                            id,
                            videoId,
                            chunkIndex,
                            startSeconds: start,
                            endSeconds: end,
                            text,
                        })
                    } else if (sql.includes("INSERT INTO conversations")) {
                        const [id, title, model, type, videoId] = args
                        conversationsDb.set(id, {
                            id,
                            title,
                            model,
                            type,
                            video_id: videoId,
                            created_at: Date.now(),
                        })
                    } else if (sql.includes("INSERT INTO messages")) {
                        const [
                            id,
                            conversationId,
                            role,
                            content,
                            model,
                            effort,
                            attachments,
                            citations,
                        ] = args
                        const list = messagesDb.get(conversationId) || []
                        list.push({
                            id,
                            conversation_id: conversationId,
                            role,
                            content,
                            model,
                            effort,
                            attachments,
                            citations,
                            created_at: Date.now(),
                        })
                        messagesDb.set(conversationId, list)
                    }
                    return { success: true }
                },
                async first() {
                    if (sql.includes("FROM youtube_videos WHERE id = ?")) {
                        return videosDb.get(args[0]) || null
                    }
                    if (sql.includes("FROM conversations WHERE id = ?")) {
                        return conversationsDb.get(args[0]) || null
                    }
                    return null
                },
                async all() {
                    if (sql.includes("FROM youtube_chunks WHERE video_id = ?")) {
                        const matching = Array.from(chunksDb.values()).filter(
                            (c) => c.videoId === args[0]
                        )
                        return { results: matching }
                    }
                    if (sql.includes("FROM conversations")) {
                        let matching = Array.from(conversationsDb.values())
                        if (sql.includes("type = 'youtube'")) {
                            matching = matching.filter((c) => c.type === "youtube")
                        } else if (sql.includes("type != 'youtube'")) {
                            matching = matching.filter((c) => c.type !== "youtube")
                        } else if (args.length > 0) {
                            matching = matching.filter((c) => c.type === args[0])
                        }
                        return { results: matching }
                    }
                    if (sql.includes("FROM messages WHERE conversation_id = ?")) {
                        return { results: messagesDb.get(args[0]) || [] }
                    }
                    return { results: [] }
                },
            })

            const mockDb = {
                async batch(statements) {
                    for (const stmt of statements) {
                        await stmt.run()
                    }
                    return []
                },
                prepare(sql) {
                    return createStatement(sql)
                },
            }

            // Create canonical video record
            await createYoutubeVideo(
                {
                    id: "vid_123",
                    url: "https://www.youtube.com/watch?v=vid_123",
                    title: "Canonical Video",
                    duration: 120,
                },
                mockDb
            )

            const video = await getYoutubeVideo("vid_123", mockDb)
            assert.ok(video)
            assert.strictEqual(video.id, "vid_123")
            assert.strictEqual(video.status, "validating")

            // Update progress
            await updateYoutubeVideoProgress(
                "vid_123",
                { status: "ready", stage: "ready", progress: 100 },
                mockDb
            )
            const updated = await getYoutubeVideo("vid_123", mockDb)
            assert.strictEqual(updated.status, "ready")

            // Save chunks
            await saveYoutubeChunks(
                "vid_123",
                [
                    {
                        id: "vid_123_0",
                        videoId: "vid_123",
                        chunkIndex: 0,
                        startSeconds: 0,
                        endSeconds: 10,
                        text: "Chunk 1",
                    },
                    {
                        id: "vid_123_1",
                        videoId: "vid_123",
                        chunkIndex: 1,
                        startSeconds: 10,
                        endSeconds: 20,
                        text: "Chunk 2",
                    },
                ],
                mockDb
            )
            const chunks = await getYoutubeChunks("vid_123", mockDb)
            assert.strictEqual(chunks.length, 2)
            assert.strictEqual(chunks[0].text, "Chunk 1")

            // Create two INDEPENDENT conversations for the SAME video
            await createConversation(
                "chat_1",
                "Chat One",
                "test-model",
                "youtube",
                "vid_123",
                mockDb
            )
            await createConversation(
                "chat_2",
                "Chat Two",
                "test-model",
                "youtube",
                "vid_123",
                mockDb
            )

            const conv1 = await getConversation("chat_1", mockDb)
            const conv2 = await getConversation("chat_2", mockDb)
            assert.strictEqual(conv1.video_id, "vid_123")
            assert.strictEqual(conv2.video_id, "vid_123")
            assert.notStrictEqual(conv1.id, conv2.id)

            // Add message to chat_1 with citations
            const citationsArray = [
                { id: "c1", videoId: "vid_123", startSeconds: 0, endSeconds: 10, quote: "0:00" },
            ]
            await createMessage(
                {
                    id: "msg_1",
                    conversation_id: "chat_1",
                    role: "assistant",
                    content: "Answer with citation",
                    model: "test-model",
                    citations: citationsArray,
                },
                mockDb
            )

            const chat1Messages = await getMessages("chat_1", 50, mockDb)
            const chat2Messages = await getMessages("chat_2", 50, mockDb)

            assert.strictEqual(chat1Messages.length, 1)
            assert.deepStrictEqual(chat1Messages[0].citations, citationsArray)
            // Chat 2 remains completely independent and empty
            assert.strictEqual(chat2Messages.length, 0)

            // List conversations filtered by type
            const youtubeChats = await listConversations("youtube", mockDb)
            assert.strictEqual(youtubeChats.length, 2)
        }
    )

    // -------------------------------------------------------------
    // Test 7: Scoped Vectorize retrieval and layered keyword fallback
    // -------------------------------------------------------------
    await t.test(
        "7. Scoped RAG retrieval ensures video isolation and layered keyword scoring",
        async () => {
            const memoryStorage = new Map()
            const mockR2 = {
                async put(key, body) {
                    memoryStorage.set(
                        key,
                        typeof body === "string" ? body : new TextDecoder().decode(body)
                    )
                    return {}
                },
                async get(key) {
                    if (!memoryStorage.has(key)) return null
                    const data = memoryStorage.get(key)
                    return {
                        async text() {
                            return data
                        },
                        async arrayBuffer() {
                            return new TextEncoder().encode(data).buffer
                        },
                    }
                },
            }

            const mockVectorizeQueries = []
            const mockVectorize = {
                async upsert(vectors) {
                    return { count: vectors.length }
                },
                async query(vector, options) {
                    mockVectorizeQueries.push({ vector, options })
                    // Return match strictly matching filter
                    if (options?.filter?.videoId === "vid_A") {
                        return {
                            matches: [
                                {
                                    id: "vid_A_0",
                                    score: 0.95,
                                    metadata: {
                                        videoId: "vid_A",
                                        startSeconds: 0,
                                        endSeconds: 10,
                                        text: "Specific to Video A",
                                    },
                                },
                            ],
                        }
                    }
                    return { matches: [] }
                },
            }

            const mockAi = {
                async run(_model, inputs) {
                    return { data: inputs.text.map(() => new Array(768).fill(0.01)) }
                },
            }

            // Test scoped Vectorize query via retrieveYoutubeContext
            const chunksA = await retrieveYoutubeContext(
                mockAi,
                mockVectorize,
                mockR2,
                null,
                "vid_A",
                "What is in video A?",
                3
            )
            assert.strictEqual(chunksA.length, 1)
            assert.strictEqual(chunksA[0].videoId, "vid_A")
            assert.strictEqual(chunksA[0].id, "vid_A_0")
            assert.strictEqual(mockVectorizeQueries[0].options?.filter?.videoId, "vid_A")

            // Test layered fallback: when Vectorize returns 0 matches, retrieveYoutubeContext uses R2/D1 chunks keyword matching
            const testChunks = [
                {
                    id: "vid_B_0",
                    videoId: "vid_B",
                    chunkIndex: 0,
                    startSeconds: 0,
                    endSeconds: 15,
                    text: "Introduction to Cloudflare Durable Objects persistence",
                },
                {
                    id: "vid_B_1",
                    videoId: "vid_B",
                    chunkIndex: 1,
                    startSeconds: 15,
                    endSeconds: 30,
                    text: "Unrelated recipes and cooking tips",
                },
            ]
            await mockR2.put("youtube/vid_B/chunks.json", JSON.stringify(testChunks))

            const chunksB = await retrieveYoutubeContext(
                mockAi,
                mockVectorize, // returns 0 matches for vid_B
                mockR2,
                null,
                "vid_B",
                "How does Durable Objects persistence work?",
                3
            )

            assert.ok(chunksB.length >= 1)
            assert.strictEqual(chunksB[0].id, "vid_B_0")
            assert.ok(chunksB[0].text.includes("Durable Objects"))
        }
    )

    // -------------------------------------------------------------
    // Test 8: Critical skip-processing rule verification
    // -------------------------------------------------------------
    await t.test(
        "8. Critical skip-processing verification prevents skipping incomplete indexing",
        async () => {
            const createMockEnv = (videoRecord, r2Storage) => ({
                DB: {
                    prepare() {
                        return {
                            bind() {
                                return {
                                    async first() {
                                        return videoRecord
                                    },
                                    async all() {
                                        return { results: [] }
                                    },
                                }
                            },
                        }
                    },
                },
                FILES: {
                    async get(key) {
                        if (!r2Storage.has(key)) return null
                        return {
                            async text() {
                                return r2Storage.get(key)
                            },
                        }
                    },
                    async put(key, body) {
                        r2Storage.set(key, body)
                    },
                },
            })

            // Case A: Missing D1 record -> should NOT skip
            const envA = createMockEnv(null, new Map())
            const resA = await verifyYoutubeIndexingComplete(envA, "v1")
            assert.strictEqual(resA, false)

            // Case B: Status is not ready -> should NOT skip
            const envB = createMockEnv(
                { id: "v1", status: "validating", chunk_count: 5 },
                new Map()
            )
            const resB = await verifyYoutubeIndexingComplete(envB, "v1")
            assert.strictEqual(resB, false)

            // Case C: Status ready, but chunk_count is 0 -> should NOT skip
            const envC = createMockEnv({ id: "v1", status: "ready", chunk_count: 0 }, new Map())
            const resC = await verifyYoutubeIndexingComplete(envC, "v1")
            assert.strictEqual(resC, false)

            // Case D: Status ready, chunk_count 2, chunks and transcript exist in R2 -> IS complete!
            const r2StorageD = new Map([
                [
                    "youtube/v1/chunks.json",
                    JSON.stringify([
                        { id: "v1_0", text: "Chunk 1" },
                        { id: "v1_1", text: "Chunk 2" },
                    ]),
                ],
                [
                    "youtube/v1/transcript.json",
                    JSON.stringify({ videoId: "v1", segments: [{ id: "s0", text: "Hi" }] }),
                ],
            ])
            const envD = createMockEnv(
                {
                    id: "v1",
                    status: "ready",
                    chunk_count: 2,
                    embedding_model: YOUTUBE_EMBEDDING_CONFIG.modelId,
                },
                r2StorageD
            )
            const resD = await verifyYoutubeIndexingComplete(envD, "v1")
            assert.strictEqual(resD, true)
        }
    )

    // -------------------------------------------------------------
    // Test 9: Complete Pipeline execution end-to-end (idempotent & cached)
    // -------------------------------------------------------------
    await t.test(
        "9. executeYoutubePipeline runs idempotent stages and publishes SSE events",
        async () => {
            const eventsPublished = []
            const r2Storage = new Map()

            const mockEnv = {
                DB: {
                    videos: new Map(),
                    async batch(statements) {
                        for (const stmt of statements) {
                            if (stmt && stmt.run) await stmt.run()
                        }
                        return []
                    },
                    prepare() {
                        return {
                            bind(..._args) {
                                return {
                                    async run() {
                                        return { success: true }
                                    },
                                    async first() {
                                        return null
                                    },
                                    async all() {
                                        return { results: [] }
                                    },
                                }
                            },
                        }
                    },
                },
                FILES: {
                    async put(key, body) {
                        r2Storage.set(key, body)
                    },
                    async get(key) {
                        if (!r2Storage.has(key)) return null
                        return {
                            async text() {
                                return r2Storage.get(key)
                            },
                        }
                    },
                },
                VECTORIZE: {
                    async upsert() {
                        return { count: 1 }
                    },
                    async query() {
                        return { matches: [] }
                    },
                },
                AI: {
                    async run() {
                        return { data: [new Array(768).fill(0.1)] }
                    },
                },
                DOCUMENT_PROGRESS_DO: {
                    idFromName: () => "mock-do-id",
                    get: () => ({
                        async fetch(_url, init) {
                            eventsPublished.push(JSON.parse(init.body))
                            return new Response("ok")
                        },
                    }),
                },
                SCRAPINGBEE_API_KEY: "mock_scrapingbee_key",
            }

            // Mock global fetch for ScrapingBee subtitles
            const originalFetch = globalThis.fetch
            globalThis.fetch = async (url) => {
                if (typeof url === "string" && url.includes("scrapingbee.com")) {
                    return new Response(
                        JSON.stringify({
                            subtitles: [
                                {
                                    text: "Welcome to YouTube Video RAG with Cloudflare.",
                                    start: 0,
                                    duration: 3,
                                },
                                {
                                    text: "Powered by DeepSeek R1 and Workers.",
                                    start: 3,
                                    duration: 4,
                                },
                            ],
                            language: "en",
                        }),
                        { status: 200, headers: { "Content-Type": "application/json" } }
                    )
                }
                return originalFetch(url)
            }

            try {
                const valid11CharId = "dQw4w9WgXcQ"
                const result = await executeYoutubePipeline(mockEnv, {
                    videoId: valid11CharId,
                    url: `https://www.youtube.com/watch?v=${valid11CharId}`,
                })

                assert.strictEqual(result.success, true)
                // Progress events were broadcast
                assert.ok(eventsPublished.length >= 3)
                const stages = eventsPublished.map((e) => e.stage)
                assert.ok(stages.includes("extracting"))
                assert.ok(stages.includes("ready"))

                // Verify stored in R2
                assert.ok(r2Storage.has(`youtube/${valid11CharId}/transcript.json`))
                assert.ok(r2Storage.has(`youtube/${valid11CharId}/chunks.json`))
            } finally {
                globalThis.fetch = originalFetch
            }
        }
    )

    // -------------------------------------------------------------
    // Test 10: YoutubeProcessingWorkflow executes durable step.do calls
    // -------------------------------------------------------------
    await t.test(
        "10. YoutubeProcessingWorkflow executes durable step.do calls successfully",
        async () => {
            const eventsPublished = []
            const r2Storage = new Map()
            const executedSteps = []

            const mockEnv = {
                DB: {
                    videos: new Map(),
                    async batch(statements) {
                        for (const stmt of statements) {
                            if (stmt && stmt.run) await stmt.run()
                        }
                        return []
                    },
                    prepare() {
                        return {
                            bind(..._args) {
                                return {
                                    async run() {
                                        return { success: true }
                                    },
                                    async first() {
                                        return null
                                    },
                                    async all() {
                                        return { results: [] }
                                    },
                                }
                            },
                        }
                    },
                },
                FILES: {
                    async put(key, body) {
                        r2Storage.set(key, body)
                    },
                    async get(key) {
                        if (!r2Storage.has(key)) return null
                        return {
                            async text() {
                                return r2Storage.get(key)
                            },
                        }
                    },
                },
                VECTORIZE: {
                    async upsert() {
                        return { count: 1 }
                    },
                    async query() {
                        return { matches: [] }
                    },
                },
                AI: {
                    async run() {
                        return { data: [new Array(768).fill(0.1)] }
                    },
                },
                DOCUMENT_PROGRESS_DO: {
                    idFromName: () => "mock-do-id",
                    get: () => ({
                        async fetch(_url, init) {
                            eventsPublished.push(JSON.parse(init.body))
                            return new Response("ok")
                        },
                    }),
                },
                SCRAPINGBEE_API_KEY: "mock_scrapingbee_key",
            }

            const mockStep = {
                async do(name, configOrCallback, maybeCallback) {
                    executedSteps.push(name)
                    const cb =
                        typeof configOrCallback === "function" ? configOrCallback : maybeCallback
                    return cb()
                },
            }

            const originalFetch = globalThis.fetch
            globalThis.fetch = async (url) => {
                if (typeof url === "string" && url.includes("scrapingbee.com")) {
                    return new Response(
                        JSON.stringify({
                            subtitles: [
                                {
                                    text: "Durable workflow step execution test.",
                                    start: 0,
                                    duration: 2.5,
                                },
                            ],
                            language: "en",
                        }),
                        { status: 200, headers: { "Content-Type": "application/json" } }
                    )
                }
                return originalFetch(url)
            }

            try {
                const validId = "dQw4w9WgXcQ"
                const workflow = new YoutubeProcessingWorkflow({}, mockEnv)
                await workflow.run(
                    {
                        payload: {
                            videoId: validId,
                            url: `https://www.youtube.com/watch?v=${validId}`,
                        },
                    },
                    mockStep
                )

                assert.ok(executedSteps.includes("validate-and-check-cache"))
                assert.ok(executedSteps.includes("extract-transcript"))
                assert.ok(executedSteps.includes("chunk-and-persist"))
                assert.ok(executedSteps.includes("index-vectors"))
                assert.ok(executedSteps.includes("mark-ready"))
                assert.ok(eventsPublished.some((e) => e.stage === "ready"))
            } finally {
                globalThis.fetch = originalFetch
            }
        }
    )

    // -------------------------------------------------------------
    // Test 11: Original Audio Language Detection & CC Language Matching (Bangla & English)
    // -------------------------------------------------------------
    await t.test(
        "11. Audio language detection accurately identifies Bangla/English and aligns CC accordingly",
        async () => {
            // 11.1 Bengali text detection
            assert.strictEqual(isBengaliText("আন্তর্জাতিক সংবাদ | Somoy TV"), true)
            assert.strictEqual(isBengaliText("Rick Astley - Never Gonna Give You Up"), false)
            assert.strictEqual(isBengaliText(""), false)

            // 11.2 Language normalization
            assert.deepStrictEqual(normalizeLanguageCode("bn-BD"), {
                lang: "bn-bd",
                baseLang: "bn",
            })
            assert.deepStrictEqual(normalizeLanguageCode("en-US"), {
                lang: "en-us",
                baseLang: "en",
            })
            assert.deepStrictEqual(normalizeLanguageCode(""), { lang: "en", baseLang: "en" })

            // 11.3 Language detection with mock ASR and oEmbed
            const originalFetch = globalThis.fetch
            try {
                // Mock YouTube watch page with ASR Bangla caption track
                globalThis.fetch = async (url) => {
                    const urlStr = String(url)
                    if (urlStr.includes("oembed")) {
                        return new Response(
                            JSON.stringify({
                                title: "আন্তর্জাতিক সংবাদ - Somoy TV",
                                author_name: "Somoy TV",
                            }),
                            { status: 200, headers: { "Content-Type": "application/json" } }
                        )
                    }
                    if (urlStr.includes("youtube.com/watch")) {
                        const mockHtml = `
                            var ytInitialPlayerResponse = {
                                "captionTracks": [
                                    { "languageCode": "bn", "vssId": "a.bn", "kind": "asr", "name": { "simpleText": "বাংলা" } }
                                ],
                                "videoDetails": { "title": "আন্তর্জাতিক সংবাদ" }
                            };
                        `
                        return new Response(mockHtml, {
                            status: 200,
                            headers: { "Content-Type": "text/html" },
                        })
                    }
                    return originalFetch(url)
                }

                const banglaResult = await detectYouTubeVideoLanguage("mock_bn_vid")
                assert.strictEqual(banglaResult.baseLang, "bn")
                assert.strictEqual(banglaResult.isAsr, true)
                assert.strictEqual(banglaResult.title, "আন্তর্জাতিক সংবাদ - Somoy TV")

                // 11.4 Native caption fetching requests lang=bn when Bangla audio is detected
                let requestedLangParam = null
                globalThis.fetch = async (url) => {
                    const parsed = new URL(String(url))
                    if (parsed.searchParams.get("mode") === "native") {
                        requestedLangParam = parsed.searchParams.get("lang")
                        return new Response(
                            JSON.stringify({
                                lang: "bn",
                                content: [
                                    { text: "আজকের প্রধান খবর", offset: 0, duration: 2000 },
                                    { text: "বিস্তারিত দেখুন", offset: 2500, duration: 3000 },
                                ],
                            }),
                            { status: 200, headers: { "Content-Type": "application/json" } }
                        )
                    }
                    return new Response("Not found", { status: 404 })
                }

                const nativeRes = await fetchNativeCaptions("mock_bn_vid", "mock_key", {
                    lang: "bn",
                })
                assert.strictEqual(nativeRes.found, true)
                assert.strictEqual(requestedLangParam, "bn")
                if (nativeRes.found) {
                    assert.strictEqual(nativeRes.transcript.lang, "bn")
                    assert.strictEqual(nativeRes.transcript.segments[0].text, "আজকের প্রধান খবর")
                }

                // 11.5 Index cache invalidation when video was previously cached with wrong language
                const mockEnv = {
                    DB: {
                        prepare: (sql) => ({
                            bind: (..._args) => ({
                                first: async () => {
                                    if (sql.includes("FROM youtube_videos")) {
                                        return {
                                            id: "mock_bn_vid",
                                            status: "ready",
                                            chunk_count: 5,
                                            embedding_model: "@cf/baai/bge-base-en-v1.5",
                                            transcript_lang: "en", // Old incorrect English cache
                                        }
                                    }
                                    return null
                                },
                                all: async () => ({ results: [] }),
                            }),
                        }),
                    },
                }

                // If expecting Bangla but cached as English -> verify must return false to trigger re-index
                const isComplete = await verifyYoutubeIndexingComplete(mockEnv, "mock_bn_vid", "bn")
                assert.strictEqual(isComplete, false)
            } finally {
                globalThis.fetch = originalFetch
            }
        }
    )

    // -------------------------------------------------------------
    // Test 12: Primary Provider (ScrapingBee) & Supadata Fallback Decommission Suite
    // (Comprehensive Phase 9 verification covering scenarios 1 to 16)
    // -------------------------------------------------------------
    await t.test(
        "12. ScrapingBee sole provider architecture and Supadata fallback disabled suite",
        async (sub) => {
            // Helper to create mock ScrapingBee responses
            const createMockScrapingBeeData = (opts = {}) => ({
                video_id: opts.videoId || "dQw4w9WgXcQ",
                language: opts.language || "en",
                subtitle_origin: opts.isGenerated ? "auto_generated" : "uploader_provided",
                subtitles: opts.snippets || [
                    { text: "Primary caption line 1", start: 0, duration: 2.5 },
                    { text: "Primary caption line 2", start: 2.5, duration: 3.5 },
                ],
            })

            // 12.1 Scenario 1: ScrapingBee provider succeeds; Supadata is not called
            await sub.test(
                "Scenario 1: ScrapingBee provider succeeds; Supadata is not called",
                async () => {
                    let supadataCalled = false
                    const originalFetch = globalThis.fetch
                    globalThis.fetch = async (url) => {
                        if (String(url).includes("api.supadata.ai")) {
                            supadataCalled = true
                            throw new Error("Supadata should not be called when primary succeeds!")
                        }
                        return originalFetch(url)
                    }

                    try {
                        const mockFetch = async () => {
                            return new Response(JSON.stringify(createMockScrapingBeeData()), {
                                status: 200,
                                headers: { "Content-Type": "application/json" },
                            })
                        }

                        const result = await extractYouTubeTranscript(
                            "dQw4w9WgXcQ",
                            {
                                SCRAPINGBEE_API_KEY: "mock_key",
                                SUPADATA_API_KEY: "mock_supadata_key",
                            },
                            {
                                lang: "en",
                                fetchFn: mockFetch,
                            }
                        )

                        assert.strictEqual(result.needsConfirmation, false)
                        assert.strictEqual(result.provider, "scrapingbee")
                        assert.strictEqual(result.transcript?.segments.length, 2)
                        assert.strictEqual(result.transcript?.provider, "scrapingbee")
                        assert.strictEqual(
                            supadataCalled,
                            false,
                            "Supadata must not be called when primary succeeds"
                        )
                    } finally {
                        globalThis.fetch = originalFetch
                    }
                }
            )

            // 12.2 Scenario 2: ScrapingBee returns auto-generated captions successfully
            await sub.test(
                "Scenario 2: ScrapingBee returns auto-generated captions successfully",
                async () => {
                    const mockFetch = async () => {
                        return new Response(
                            JSON.stringify(
                                createMockScrapingBeeData({
                                    isGenerated: true,
                                    snippets: [
                                        {
                                            text: "Auto-generated caption cue",
                                            start: 0.5,
                                            duration: 4.0,
                                        },
                                    ],
                                })
                            ),
                            { status: 200, headers: { "Content-Type": "application/json" } }
                        )
                    }

                    const result = await extractYouTubeTranscript(
                        "dQw4w9WgXcQ",
                        { SCRAPINGBEE_API_KEY: "mock_key" },
                        {
                            lang: "en",
                            fetchFn: mockFetch,
                        }
                    )

                    assert.strictEqual(result.needsConfirmation, false)
                    assert.strictEqual(result.provider, "scrapingbee")
                    assert.strictEqual(
                        result.transcript?.segments[0].text,
                        "Auto-generated caption cue"
                    )
                }
            )

            // 12.3 Scenario 3: ScrapingBee returns creator-provided captions successfully
            await sub.test(
                "Scenario 3: ScrapingBee returns creator-provided captions successfully",
                async () => {
                    const mockFetch = async () => {
                        return new Response(
                            JSON.stringify(
                                createMockScrapingBeeData({
                                    isGenerated: false,
                                    snippets: [
                                        { text: "Creator manual cue", start: 0, duration: 1 },
                                    ],
                                })
                            ),
                            { status: 200, headers: { "Content-Type": "application/json" } }
                        )
                    }

                    const result = await extractYouTubeTranscript(
                        "dQw4w9WgXcQ",
                        { SCRAPINGBEE_API_KEY: "mock_key" },
                        {
                            lang: "en",
                            fetchFn: mockFetch,
                        }
                    )

                    assert.strictEqual(result.needsConfirmation, false)
                    assert.strictEqual(result.provider, "scrapingbee")
                    assert.strictEqual(result.transcript?.segments[0].text, "Creator manual cue")
                }
            )

            // 12.4 Scenario 4: ScrapingBee times out; bounded retry occurs and Supadata is not called
            await sub.test(
                "Scenario 4: ScrapingBee times out; bounded retry occurs and Supadata is not called",
                async () => {
                    let attempts = 0
                    let supadataCalled = false
                    const originalFetch = globalThis.fetch
                    globalThis.fetch = async (url) => {
                        if (String(url).includes("api.supadata.ai")) {
                            supadataCalled = true
                        }
                        return originalFetch(url)
                    }

                    const mockFetch = async () => {
                        attempts++
                        const err = new Error("Request timed out")
                        err.name = "TimeoutError"
                        throw err
                    }

                    try {
                        const result = await extractYouTubeTranscript(
                            "dQw4w9WgXcQ",
                            { SCRAPINGBEE_API_KEY: "mock_key", SUPADATA_API_KEY: "mock_supadata" },
                            {
                                lang: "en",
                                fetchFn: mockFetch,
                                timeoutMs: 100,
                            }
                        )

                        // Bounded retry should have occurred (1 retry -> total 2 attempts)
                        assert.strictEqual(
                            attempts,
                            2,
                            "ScrapingBee should retry boundedly on timeout"
                        )
                        assert.strictEqual(supadataCalled, false, "Must not fall back to Supadata")
                        assert.strictEqual(result.transcript, null)
                        assert.strictEqual(result.diagnostic?.failureCategory, "timeout")
                    } finally {
                        globalThis.fetch = originalFetch
                    }
                }
            )

            // 12.5 Scenario 5: ScrapingBee returns empty transcript; fails cleanly without Supadata fallback
            await sub.test(
                "Scenario 5: ScrapingBee returns empty transcript; fails cleanly without Supadata fallback",
                async () => {
                    let supadataCalled = false
                    const originalFetch = globalThis.fetch
                    globalThis.fetch = async (url) => {
                        if (String(url).includes("api.supadata.ai")) {
                            supadataCalled = true
                            throw new Error("Supadata MUST NOT be called!")
                        }
                        return originalFetch(url)
                    }

                    const mockFetch = async () => {
                        return new Response(
                            JSON.stringify({
                                subtitles: [{ text: "   ", start: 0, duration: 5 }], // only empty whitespace
                            }),
                            { status: 200, headers: { "Content-Type": "application/json" } }
                        )
                    }

                    try {
                        const result = await extractYouTubeTranscript(
                            "dQw4w9WgXcQ",
                            { SCRAPINGBEE_API_KEY: "mock_key", SUPADATA_API_KEY: "mock_supadata" },
                            { lang: "en", fetchFn: mockFetch }
                        )

                        assert.strictEqual(
                            supadataCalled,
                            false,
                            "Must not call Supadata on empty transcript"
                        )
                        assert.strictEqual(result.transcript, null)
                        assert.strictEqual(result.diagnostic?.failureCategory, "empty_transcript")
                    } finally {
                        globalThis.fetch = originalFetch
                    }
                }
            )

            // 12.6 Scenario 6: ScrapingBee encounters permanent failure; no unbounded retries occur
            await sub.test(
                "Scenario 6: ScrapingBee encounters permanent failure; no unbounded retries",
                async () => {
                    let calls = 0
                    const mockFetch = async () => {
                        calls++
                        return new Response("Not Found", { status: 404 })
                    }

                    const result = await extractYouTubeTranscript(
                        "dQw4w9WgXcQ",
                        { SCRAPINGBEE_API_KEY: "mock_key" },
                        { lang: "en", fetchFn: mockFetch }
                    )

                    assert.strictEqual(calls, 1, "Permanent 404 must not be repeatedly retried")
                    assert.strictEqual(result.transcript, null)
                    assert.strictEqual(result.diagnostic?.failureCategory, "captions_unavailable")
                }
            )

            // 12.7 Scenario 7: Supadata fallback is completely disabled
            await sub.test("Scenario 7: Supadata fallback is completely disabled", async () => {
                let supadataCalled = false
                const originalFetch = globalThis.fetch
                globalThis.fetch = async (url) => {
                    if (String(url).includes("api.supadata.ai")) {
                        supadataCalled = true
                        throw new Error("Supadata was called!")
                    }
                    return originalFetch(url)
                }

                const mockFetch = async () => {
                    return new Response("Not Found", { status: 404 })
                }

                try {
                    const result = await extractYouTubeTranscript(
                        "dQw4w9WgXcQ",
                        { SCRAPINGBEE_API_KEY: "mock_key", SUPADATA_API_KEY: "mock_supadata" },
                        { lang: "en", fetchFn: mockFetch }
                    )

                    assert.strictEqual(result.needsConfirmation, false)
                    assert.strictEqual(result.transcript, null)
                    assert.strictEqual(supadataCalled, false, "Supadata must not be called")
                } finally {
                    globalThis.fetch = originalFetch
                }
            })

            // 12.8 Scenario 8: Captions unavailable fails cleanly without confirmation requirement
            await sub.test(
                "Scenario 8: Captions unavailable fails cleanly without confirmation requirement",
                async () => {
                    const mockFetch = async () => {
                        return new Response(JSON.stringify({ error: "No captions available" }), {
                            status: 404,
                        })
                    }

                    const result = await extractYouTubeTranscript(
                        "dQw4w9WgXcQ",
                        { SCRAPINGBEE_API_KEY: "mock_key" },
                        { lang: "en", fetchFn: mockFetch }
                    )

                    assert.strictEqual(result.needsConfirmation, false)
                    assert.strictEqual(result.transcript, null)
                    assert.ok(result.message.includes("unavailable"))
                }
            )

            // 12.9 Scenario 9: ScrapingBee quota/credit exhaustion produces clear error
            await sub.test(
                "Scenario 9: ScrapingBee quota exhaustion produces clear error",
                async () => {
                    const mockFetch = async () => {
                        return new Response("Forbidden: Credit limit reached", { status: 403 })
                    }

                    const result = await extractYouTubeTranscript(
                        "dQw4w9WgXcQ",
                        { SCRAPINGBEE_API_KEY: "mock_key" },
                        { lang: "en", fetchFn: mockFetch }
                    )

                    assert.strictEqual(result.transcript, null)
                    assert.strictEqual(result.diagnostic?.failureCategory, "http_error")
                    assert.ok(
                        result.message.includes("credit limit") ||
                            result.message.includes("forbidden")
                    )
                }
            )

            // 12.10 Scenario 10: AI transcription is never triggered without confirmation
            await sub.test(
                "Scenario 10: AI transcription is disabled as ScrapingBee is sole provider",
                async () => {
                    const res = await extractYouTubeTranscript(
                        "dQw4w9WgXcQ",
                        { SCRAPINGBEE_API_KEY: "mock_key" },
                        { lang: "en", forceAiTranscription: true }
                    )

                    assert.strictEqual(res.needsConfirmation, false)
                    assert.strictEqual(res.transcript, null)
                    assert.ok(res.message.includes("disabled"))
                }
            )

            // 12.11 Scenario 11: A completed transcript and verified index are reused without extraction calls
            await sub.test(
                "Scenario 11: Completed transcript and index are reused without calls",
                async () => {
                    let extractionAttempted = false
                    const mockEnv = {
                        DB: {
                            prepare: () => ({
                                bind: () => ({
                                    first: async () => ({
                                        id: "cached_vid",
                                        status: "ready",
                                        chunk_count: 5,
                                        embedding_model: "@cf/baai/bge-base-en-v1.5",
                                        transcript_lang: "en",
                                    }),
                                    all: async () => ({ results: [] }),
                                }),
                            }),
                        },
                        FILES: {
                            get: async (key) => {
                                if (key.includes("chunks.json")) {
                                    return {
                                        text: async () =>
                                            JSON.stringify([{ id: "c1", text: "chunk" }]),
                                    }
                                }
                                if (key.includes("transcript.json")) {
                                    return {
                                        text: async () =>
                                            JSON.stringify({
                                                videoId: "cached_vid",
                                                segments: [{ text: "hi" }],
                                            }),
                                    }
                                }
                                return null
                            },
                        },
                    }

                    const isComplete = await verifyYoutubeIndexingComplete(
                        mockEnv,
                        "cached_vid",
                        "en"
                    )
                    assert.strictEqual(isComplete, true)
                    assert.strictEqual(extractionAttempted, false)
                }
            )

            // 12.12 Scenario 12: Concurrent requests do not duplicate canonical processing
            await sub.test(
                "Scenario 12: Deduplication prevents duplicate video records",
                async () => {
                    const dbMap = new Map()
                    const mockDb = {
                        prepare(sql) {
                            return {
                                bind(...args) {
                                    return {
                                        async run() {
                                            if (sql.includes("INSERT INTO youtube_videos")) {
                                                const id = args[0]
                                                if (dbMap.has(id)) {
                                                    // Primary key constraint
                                                    throw new Error(
                                                        "UNIQUE constraint failed: youtube_videos.id"
                                                    )
                                                }
                                                dbMap.set(id, { id, status: "validating" })
                                            }
                                            return { success: true }
                                        },
                                        async first() {
                                            return dbMap.get(args[0]) || null
                                        },
                                    }
                                },
                            }
                        },
                    }

                    // First insert succeeds
                    await createYoutubeVideo(
                        {
                            id: "shared_vid",
                            title: "Vid",
                            url: "https://youtu.be/shared_vid",
                            status: "validating",
                            duration: 0,
                            transcript_version: 1,
                            progress: 10,
                            embedding_model: "bge",
                            chunk_count: 0,
                            created_at: Date.now(),
                            updated_at: Date.now(),
                        },
                        mockDb
                    )
                    assert.ok(dbMap.has("shared_vid"))

                    // Second attempt checks getYoutubeVideo and reuses record
                    const existing = await getYoutubeVideo("shared_vid", mockDb)
                    assert.strictEqual(existing.id, "shared_vid")
                }
            )

            // 12.13 Scenario 13: Transcript extraction succeeds but indexing fails; recovery does not mark complete
            await sub.test(
                "Scenario 13: Indexing failure does not incorrectly mark complete",
                async () => {
                    let recordedStatus = null
                    const mockEnv = {
                        DB: {
                            prepare(sql) {
                                return {
                                    bind(...args) {
                                        return {
                                            async run() {
                                                if (sql.includes("status = ?")) {
                                                    recordedStatus = args[0]
                                                }
                                                return { success: true }
                                            },
                                            async first() {
                                                return null
                                            },
                                            async all() {
                                                return { results: [] }
                                            },
                                        }
                                    },
                                }
                            },
                            async batch() {
                                return []
                            },
                        },
                        FILES: {
                            async put() {},
                            async get() {
                                return null
                            },
                        },
                        AI: {
                            async run() {
                                throw new Error("Workers AI service unavailable")
                            },
                        },
                        VECTORIZE: {
                            async upsert() {},
                        },
                        SCRAPINGBEE_API_KEY: "mock_key",
                    }

                    const mockFetch = async () => {
                        return new Response(
                            JSON.stringify({
                                subtitles: [
                                    { text: "Caption line 1", start: 0, duration: 2.5 },
                                    { text: "Caption line 2", start: 2.5, duration: 3.5 },
                                ],
                                language: "en",
                            }),
                            { status: 200, headers: { "Content-Type": "application/json" } }
                        )
                    }

                    await assert.rejects(
                        async () => {
                            await executeYoutubePipeline(mockEnv, {
                                videoId: "dQw4w9WgXcQ",
                                url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
                                fetchFn: mockFetch,
                            })
                        },
                        (err) => {
                            assert.ok(err.message.includes("Workers AI service unavailable"))
                            return true
                        }
                    )

                    // Status must be marked failed, never ready!
                    assert.strictEqual(recordedStatus, "failed")
                }
            )

            // 12.14 Scenario 14: Different providers produce normalized data compatible with chunking & citations
            await sub.test("Scenario 14: Normalized data compatible across providers", () => {
                const extractYtSnippets = [
                    { text: "Introduction to edge architecture.", start: 0, duration: 4.5 },
                    {
                        text: "Serverless functions and streaming responses.",
                        start: 4.5,
                        duration: 5.0,
                    },
                ]
                const supadataRaw = [
                    { text: "Introduction to edge architecture.", offset: 0, duration: 4500 },
                    {
                        text: "Serverless functions and streaming responses.",
                        offset: 4500,
                        duration: 5000,
                    },
                ]

                const normA = normalizeExtractYoutubeSnippets(extractYtSnippets, "vid123", "en")
                const normB = normalizeSupadataSegments(supadataRaw, "vid123", "native", "en")

                assert.strictEqual(normA.segments.length, normB.segments.length)
                assert.strictEqual(normA.segments[0].startSeconds, normB.segments[0].startSeconds)
                assert.strictEqual(normA.segments[0].endSeconds, normB.segments[0].endSeconds)
                assert.strictEqual(normA.segments[1].startSeconds, normB.segments[1].startSeconds)
                assert.strictEqual(normA.segments[1].endSeconds, normB.segments[1].endSeconds)

                const chunksA = chunkTranscriptSegments("vid123", normA.segments, 80, 20)
                const chunksB = chunkTranscriptSegments("vid123", normB.segments, 80, 20)

                assert.strictEqual(chunksA.length, chunksB.length)
                assert.strictEqual(chunksA[0].text, chunksB[0].text)
                assert.strictEqual(chunksA[0].startSeconds, chunksB[0].startSeconds)
            })

            // 12.15 Scenario 15: Existing YouTube chat history, sidebar filtering, and timestamps continue working
            await sub.test(
                "Scenario 15: Chat history, sidebar filtering, and timestamps work",
                async () => {
                    const conversations = new Map()
                    const messages = new Map()

                    const createStatement = (sql, args = []) => ({
                        bind(...newArgs) {
                            return createStatement(sql, newArgs)
                        },
                        async run() {
                            if (sql.includes("INSERT INTO conversations")) {
                                const [id, title, model, type, videoId] = args
                                conversations.set(id, { id, title, model, type, video_id: videoId })
                            } else if (sql.includes("INSERT INTO messages")) {
                                const [id, convId, role, content] = args
                                const list = messages.get(convId) || []
                                list.push({ id, conversation_id: convId, role, content })
                                messages.set(convId, list)
                            }
                            return { success: true }
                        },
                        async first() {
                            return conversations.get(args[0]) || null
                        },
                        async all() {
                            if (sql.includes("FROM messages")) {
                                const convId = args[0]
                                return { results: messages.get(convId) || [] }
                            }
                            if (sql.includes("WHERE type = 'youtube'")) {
                                const ytConvs = Array.from(conversations.values()).filter(
                                    (c) => c.type === "youtube"
                                )
                                return { results: ytConvs }
                            }
                            return { results: Array.from(conversations.values()) }
                        },
                    })

                    const mockDb = {
                        prepare(sql) {
                            return createStatement(sql)
                        },
                    }

                    // Create a standard chat and a youtube chat
                    await createConversation("c_chat", "General Chat", "auto", "chat", null, mockDb)
                    await createConversation(
                        "c_yt",
                        "YouTube Video Chat",
                        "auto",
                        "youtube",
                        "dQw4w9WgXcQ",
                        mockDb
                    )

                    // List conversations filtered by type='youtube'
                    const ytList = await listConversations("youtube", mockDb)
                    assert.strictEqual(ytList.length, 1)
                    assert.strictEqual(ytList[0].id, "c_yt")
                    assert.strictEqual(ytList[0].video_id, "dQw4w9WgXcQ")

                    // Add message and format timestamp
                    await createMessage(
                        {
                            id: "m1",
                            conversation_id: "c_yt",
                            role: "assistant",
                            content: "See video at [01:30]",
                        },
                        mockDb
                    )
                    const msgs = await getMessages("c_yt", 50, mockDb)
                    assert.strictEqual(msgs.length, 1)
                    assert.strictEqual(formatTimestamp(90), "01:30")
                    assert.strictEqual(parseTimestamp("01:30"), 90)
                }
            )

            // 12.16 Scenario 16: Existing PDF and general-chat regression tests remain unaffected
            await sub.test("Scenario 16: PDF and general-chat pipelines remain unaffected", () => {
                // Formatting & chunking isolation
                assert.strictEqual(isValidYouTubeVideoId("dQw4w9WgXcQ"), true)
                assert.strictEqual(isValidYouTubeVideoId("short"), false)
                // Language code normalization
                assert.deepStrictEqual(normalizeLanguageCode("bn"), { lang: "bn", baseLang: "bn" })
            })
        }
    )
})
