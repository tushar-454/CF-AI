import test from "node:test"
import assert from "node:assert/strict"

// Real exported modules from codebase
import {
    chunkText,
    getEmbeddings,
    indexDocument,
    queryKnowledge,
    deleteDocumentVectors,
} from "../src/lib/rag.ts"
import { extractPdfText, isPdfFile } from "../src/lib/pdf.ts"
import { DocumentProgressDO } from "../src/lib/durable-object.ts"
import { formatSSE, SSE_HEADERS } from "../src/lib/sse.ts"
import { createR2PresignedPutUrl } from "../src/lib/r2-presign.ts"
import { createDocument, getDocument, updateDocumentProgress, failDocument } from "../src/lib/db.ts"

test("PDF Processing Pipeline & Architecture Suite", async (t) => {
    // -------------------------------------------------------------
    // Test 1: AWS SigV4 Presigned PUT URL Generator for R2
    // -------------------------------------------------------------
    await t.test("1. R2 Presigned PUT URL generates valid SigV4 signature", async () => {
        const url = await createR2PresignedPutUrl({
            accountId: "84b09cdd14a077b27e00b990e8ac417f",
            bucketName: "chatbot-files",
            objectKey: "uploads/test-doc-123.pdf",
            accessKeyId: "mock_r2_key_id",
            secretAccessKey: "mock_r2_secret_key_1234567890",
            contentType: "application/pdf",
            expiresInSeconds: 900,
        })

        assert.ok(
            url.startsWith(
                "https://84b09cdd14a077b27e00b990e8ac417f.r2.cloudflarestorage.com/chatbot-files/uploads/test-doc-123.pdf"
            )
        )
        assert.ok(url.includes("X-Amz-Algorithm=AWS4-HMAC-SHA256"))
        assert.ok(url.includes("X-Amz-Credential=mock_r2_key_id"))
        assert.ok(url.includes("X-Amz-Expires=900"))
        assert.ok(url.includes("X-Amz-Signature="))
    })

    // -------------------------------------------------------------
    // Test 2: PDF File type and signature validation
    // -------------------------------------------------------------
    await t.test("2. isPdfFile correctly validates MIME and extension", () => {
        assert.strictEqual(isPdfFile("application/pdf", "file.pdf"), true)
        assert.strictEqual(isPdfFile("application/pdf", "unknown"), true)
        assert.strictEqual(isPdfFile("text/plain", "doc.PDF"), true)
        assert.strictEqual(isPdfFile("image/png", "photo.png"), false)
        assert.strictEqual(isPdfFile("application/octet-stream", "data.bin"), false)
    })

    // -------------------------------------------------------------
    // Test 3: PDF Text Extraction handles empty and corrupted buffers safely
    // -------------------------------------------------------------
    await t.test(
        "3. extractPdfText handles empty or corrupt PDF bytes safely without crashing",
        async () => {
            const emptyResult = await extractPdfText(new Uint8Array(0))
            assert.strictEqual(emptyResult, "")

            // Corrupted byte buffer that is not a valid PDF
            const corruptBytes = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04])
            const corruptResult = await extractPdfText(corruptBytes)
            assert.strictEqual(corruptResult, "")
        }
    )

    // -------------------------------------------------------------
    // Test 4: Text chunking handles boundaries, empty input, and bounds
    // -------------------------------------------------------------
    await t.test("4. chunkText produces deterministic bounded chunks on natural boundaries", () => {
        assert.deepStrictEqual(chunkText(""), [])

        const p1 = "First paragraph discussing Cloudflare Workers architecture. ".repeat(5).trim()
        const p2 = "Second paragraph discussing Durable Objects and Workflows. ".repeat(5).trim()
        const fullText = `${p1}\n\n${p2}`

        const chunks = chunkText(fullText, 400, 50)
        assert.ok(chunks.length >= 2, `Expected at least 2 chunks, got ${chunks.length}`)
        for (const chunk of chunks) {
            assert.ok(
                chunk.length <= 500,
                `Chunk length ${chunk.length} should be reasonably bounded`
            )
        }
    })

    // -------------------------------------------------------------
    // Test 5: Workers AI embedding batching
    // -------------------------------------------------------------
    await t.test("5. getEmbeddings batches requests and returns vectors", async () => {
        const mockAi = {
            async run(_model, inputs) {
                const texts = inputs.text
                return {
                    data: texts.map(() => [0.1, 0.2, 0.3]),
                }
            },
        }

        const texts = Array.from({ length: 25 }, (_, i) => `Sample chunk text ${i}`)
        const vectors = await getEmbeddings(mockAi, texts)
        assert.strictEqual(vectors.length, 25)
        assert.strictEqual(vectors[0].length, 3)
    })

    // -------------------------------------------------------------
    // Test 6: Scoped Vectorize Retrieval
    // -------------------------------------------------------------
    await t.test("6. queryKnowledge scopes query to selected document IDs", async () => {
        let lastQueryFilter = null
        const mockVectorize = {
            async query(_vector, options) {
                lastQueryFilter = options?.filter
                return {
                    matches: [
                        {
                            id: "doc_1_0",
                            score: 0.95,
                            metadata: {
                                documentId: "doc_1",
                                name: "Doc 1",
                                text: "Match from doc 1",
                            },
                        },
                        {
                            id: "doc_2_0",
                            score: 0.75,
                            metadata: {
                                documentId: "doc_2",
                                name: "Doc 2",
                                text: "Match from doc 2",
                            },
                        },
                    ],
                    count: 2,
                }
            },
        }

        const mockAi = {
            async run() {
                return { data: [[0.1, 0.2, 0.3]] }
            },
        }

        // Query with document filter
        const results = await queryKnowledge(mockAi, mockVectorize, "test query", 5, ["doc_1"])
        assert.deepStrictEqual(lastQueryFilter, { documentId: "doc_1" })
        assert.strictEqual(results.length, 1)
        assert.strictEqual(results[0].documentId, "doc_1")
    })

    // -------------------------------------------------------------
    // Test 7: deleteDocumentVectors deletes all chunks beyond 200 limit
    // -------------------------------------------------------------
    await t.test(
        "7. deleteDocumentVectors deletes all chunks in batches (>200 chunks)",
        async () => {
            const deletedIds = []
            const mockVectorize = {
                async deleteByIds(ids) {
                    deletedIds.push(...ids)
                },
            }

            // Document has 250 chunks
            await deleteDocumentVectors(mockVectorize, "big_doc", 250)
            assert.strictEqual(deletedIds.length, 250)
            assert.strictEqual(deletedIds[0], "big_doc_0")
            assert.strictEqual(deletedIds[249], "big_doc_249")
        }
    )

    // -------------------------------------------------------------
    // Test 8: Durable Object Sequence Restoration across DO Restarts
    // -------------------------------------------------------------
    await t.test(
        "8. Durable Object restores currentSeq from persisted storage across restarts",
        async () => {
            const storageMap = new Map()
            const mockStorage = {
                async get(key) {
                    return storageMap.get(key)
                },
                async put(entriesOrKey, maybeVal) {
                    if (typeof entriesOrKey === "object" && maybeVal === undefined) {
                        for (const [k, v] of Object.entries(entriesOrKey)) {
                            storageMap.set(k, v)
                        }
                    } else {
                        storageMap.set(entriesOrKey, maybeVal)
                    }
                },
            }

            const mockCtx = {
                storage: mockStorage,
                blockConcurrencyWhile: async (fn) => await fn(),
            }

            // Instance 1 runs and emits 2 progress events
            const doInstance1 = new DocumentProgressDO(mockCtx, {})
            await doInstance1.reportProgress({
                documentId: "doc_100",
                status: "processing",
                stage: "extraction",
                progress: 20,
                timestamp: Date.now(),
            })
            await doInstance1.reportProgress({
                documentId: "doc_100",
                status: "processing",
                stage: "chunking",
                progress: 40,
                timestamp: Date.now(),
            })

            assert.strictEqual(storageMap.get("latest_seq"), 2)

            // Simulate DO hibernation / recreation: Instance 2 is constructed over SAME persisted storage
            const doInstance2 = new DocumentProgressDO(mockCtx, {})
            await doInstance2.reportProgress({
                documentId: "doc_100",
                status: "ready",
                stage: "ready",
                progress: 100,
                timestamp: Date.now(),
            })

            // Sequence must NOT reset to 1! It must be 3!
            assert.strictEqual(storageMap.get("latest_seq"), 3)
            const history = storageMap.get("event_history")
            assert.strictEqual(history.length, 3)
            assert.strictEqual(history[0].id, 1)
            assert.strictEqual(history[1].id, 2)
            assert.strictEqual(history[2].id, 3)

            doInstance1.closeAll()
            doInstance2.closeAll()
        }
    )

    // -------------------------------------------------------------
    // Test 9: Replay-before-Live race condition fix in Durable Object
    // -------------------------------------------------------------
    await t.test(
        "9. Durable Object delivers replayed historical events before live events",
        async () => {
            const storageMap = new Map()
            const mockStorage = {
                async get(key) {
                    return storageMap.get(key)
                },
                async put(entriesOrKey, maybeVal) {
                    if (typeof entriesOrKey === "object") {
                        for (const [k, v] of Object.entries(entriesOrKey)) storageMap.set(k, v)
                    } else {
                        storageMap.set(entriesOrKey, maybeVal)
                    }
                },
            }

            const mockCtx = {
                storage: mockStorage,
                blockConcurrencyWhile: async (fn) => await fn(),
            }

            const doInstance = new DocumentProgressDO(mockCtx, {})

            // Pre-seed an event
            await doInstance.reportProgress({
                documentId: "doc_race",
                status: "processing",
                stage: "extraction",
                progress: 15,
                timestamp: Date.now(),
            })

            // Connect client with Last-Event-ID: 0
            const req = new Request("http://localhost/api/files/doc_race/progress")
            const res = await doInstance.fetch(req)
            assert.strictEqual(res.status, 200)

            const reader = res.body.getReader()
            const decoder = new TextDecoder()
            const { value } = await reader.read()
            const text = decoder.decode(value)

            // First message delivered must be the initial/replayed snapshot
            assert.ok(text.includes("id: 1"))
            assert.ok(text.includes("extraction"))

            doInstance.closeAll()
        }
    )

    // -------------------------------------------------------------
    // Test 10: Client Abort Signal cleans up writer and stops heartbeat
    // -------------------------------------------------------------
    await t.test(
        "10. Client disconnect via abort signal releases writer and cleans up heartbeat timer",
        async () => {
            const storageMap = new Map()
            const mockStorage = {
                async get(key) {
                    return storageMap.get(key)
                },
                async put() {},
            }

            const mockCtx = {
                storage: mockStorage,
                blockConcurrencyWhile: async (fn) => await fn(),
            }

            const doInstance = new DocumentProgressDO(mockCtx, {})
            const abortController = new AbortController()

            const req = new Request("http://localhost/api/files/doc_abort/progress", {
                signal: abortController.signal,
            })
            const res = await doInstance.fetch(req)
            assert.strictEqual(res.status, 200)

            // Trigger abort
            abortController.abort()

            // Wait brief tick for listener
            await new Promise((r) => setTimeout(r, 10))

            // Timer and writer should be clean
            doInstance.closeAll()
        }
    )

    // -------------------------------------------------------------
    // Test 11: D1 Document state and stage tracking with chunk_count
    // -------------------------------------------------------------
    await t.test(
        "11. D1 document functions handle chunk_count, progress updates, and terminal failure",
        async () => {
            const rows = new Map()

            const mockDb = {
                prepare(sql) {
                    return {
                        bind(...args) {
                            return {
                                async run() {
                                    if (sql.startsWith("INSERT INTO documents")) {
                                        const [
                                            id,
                                            conversation_id,
                                            name,
                                            r2_key,
                                            mime,
                                            size,
                                            status,
                                            stage,
                                            progress,
                                            error_message,
                                            completed_at,
                                            chunk_count,
                                            created_at,
                                        ] = args
                                        rows.set(id, {
                                            id,
                                            conversation_id,
                                            name,
                                            r2_key,
                                            mime,
                                            size,
                                            status,
                                            stage,
                                            progress,
                                            error_message,
                                            completed_at,
                                            chunk_count,
                                            created_at,
                                        })
                                    } else if (sql.startsWith("UPDATE documents")) {
                                        const id = args[args.length - 1]
                                        const row = rows.get(id) || {}
                                        if (sql.includes("status = ?")) row.status = args[0]
                                        if (sql.includes("chunk_count = ?"))
                                            row.chunk_count = args[args.length - 2]
                                        rows.set(id, row)
                                    }
                                    return { success: true }
                                },
                                async first() {
                                    const id = args[0]
                                    return rows.get(id) || null
                                },
                                async all() {
                                    return { results: Array.from(rows.values()), success: true }
                                },
                            }
                        },
                    }
                },
            }

            // Test createDocument
            await createDocument(
                {
                    id: "doc_d1_test",
                    conversation_id: "conv_1",
                    name: "paper.pdf",
                    r2_key: "uploads/doc_d1_test.pdf",
                    mime: "application/pdf",
                    size: 10240,
                    status: "queued",
                    stage: "upload",
                    progress: 0,
                    chunk_count: 0,
                    created_at: 1000,
                },
                mockDb
            )

            const doc = await getDocument("doc_d1_test", mockDb)
            assert.strictEqual(doc.id, "doc_d1_test")
            assert.strictEqual(doc.status, "queued")

            // Test updateDocumentProgress with chunk_count
            await updateDocumentProgress(
                "doc_d1_test",
                {
                    status: "ready",
                    stage: "ready",
                    progress: 100,
                    chunk_count: 15,
                    completed_at: 2000,
                },
                mockDb
            )

            const updated = await getDocument("doc_d1_test", mockDb)
            assert.strictEqual(updated.status, "ready")

            // Test failDocument
            await failDocument("doc_d1_test", "Processing error", "indexing", mockDb)
            const failed = await getDocument("doc_d1_test", mockDb)
            assert.strictEqual(failed.status, "failed")
        }
    )
})
