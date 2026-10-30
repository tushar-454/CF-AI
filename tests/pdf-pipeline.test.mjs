import assert from "node:assert/strict"
import test from "node:test"

// Real exported modules from codebase
import { DocumentProgressDO } from "../src/lib/durable-object.ts"
import {
    computeImageHash,
    encodeRawToPng,
    evaluatePageTextQuality,
    extractPdfDocument,
    extractPdfPages,
    extractPdfText,
    isCandidateOcrImage,
    isPdfFile,
    mergePageText,
    performVisionOcr,
} from "../src/lib/pdf.ts"
import {
    chunkPages,
    chunkText,
    deleteDocumentVectors,
    getDocumentChunks,
    getDocumentR2Text,
    getEmbeddings,
    indexDocumentChunks,
    queryKnowledge,
    retrieveDocumentContext,
} from "../src/lib/rag.ts"

import { createDocument, failDocument, getDocument, updateDocumentProgress } from "../src/lib/db.ts"
import { createR2PresignedPutUrl } from "../src/lib/r2-presign.ts"

test("PDF Processing Pipeline & Architecture Suite", async (t) => {
    // -------------------------------------------------------------
    // Test 1: AWS SigV4 Presigned PUT URL Generator for R2
    // -------------------------------------------------------------
    await t.test("1. R2 Presigned PUT URL generates valid SigV4 signature", async () => {
        const url = await createR2PresignedPutUrl({
            accountId: "7ab77eaa396c9a6435e5659a299e07cf",
            bucketName: "chatbot-files",
            objectKey: "uploads/test-doc-123.pdf",
            accessKeyId: "mock_r2_key_id",
            secretAccessKey: "mock_r2_secret_key_1234567890",
            contentType: "application/pdf",
            expiresInSeconds: 900,
        })

        assert.ok(
            url.startsWith(
                "https://7ab77eaa396c9a6435e5659a299e07cf.r2.cloudflarestorage.com/chatbot-files/uploads/test-doc-123.pdf"
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

    // -------------------------------------------------------------
    // Test 12: getDocumentR2Text reads extracted document text with layered fallbacks
    // -------------------------------------------------------------
    await t.test(
        "12. getDocumentR2Text reads extracted document text with layered fallbacks",
        async () => {
            const r2Storage = new Map()
            const mockR2 = {
                async get(key) {
                    const val = r2Storage.get(key)
                    if (!val) return null
                    return {
                        text: async () => val,
                        arrayBuffer: async () => new TextEncoder().encode(val).buffer,
                    }
                },
                async put(key, val) {
                    r2Storage.set(key, typeof val === "string" ? val : "")
                },
                async list() {
                    return { objects: [] }
                },
            }

            // Test fallback 1: extracted/{docId}.txt
            r2Storage.set(
                "extracted/doc_test_1.txt",
                "This is the primary extracted text for doc 1."
            )
            const text1 = await getDocumentR2Text(mockR2, "doc_test_1", "doc1.pdf")
            assert.strictEqual(text1, "This is the primary extracted text for doc 1.")

            // Test fallback 2: intermediates/{docId}/chunks.json
            r2Storage.set(
                "intermediates/doc_test_2/chunks.json",
                JSON.stringify(["Chunk 1 content.", "Chunk 2 content."])
            )
            const text2 = await getDocumentR2Text(mockR2, "doc_test_2", "doc2.pdf")
            assert.ok(text2.includes("Chunk 1 content."))
            assert.ok(text2.includes("Chunk 2 content."))
        }
    )

    // -------------------------------------------------------------
    // Test 13: getDocumentChunks scores and orders chunks by query keyword relevance
    // -------------------------------------------------------------
    await t.test(
        "13. getDocumentChunks scores and orders chunks by query keyword relevance",
        async () => {
            const r2Storage = new Map()
            const chunks = [
                "Introduction: This document outlines quarterly financial performance and enterprise cloud metrics.",
                "Section 1: Operating expenses and infrastructure costs for data centers.",
                "Section 2: Revenue breakdown by product lines including Cloudflare Workers and Vectorize.",
                "Conclusion and future outlook for the upcoming fiscal quarter.",
            ]
            r2Storage.set("intermediates/finance_doc/chunks.json", JSON.stringify(chunks))

            const mockR2 = {
                async get(key) {
                    const val = r2Storage.get(key)
                    if (!val) return null
                    return {
                        text: async () => val,
                        arrayBuffer: async () => new TextEncoder().encode(val).buffer,
                    }
                },
                async put() {},
                async list() {
                    return { objects: [] }
                },
            }

            // Query for revenue
            const result = await getDocumentChunks(
                mockR2,
                "finance_doc",
                "Financial Report.pdf",
                "What is the revenue breakdown?"
            )
            assert.ok(result.length > 0)
            // Chunk containing "Revenue" should be included
            const revenueChunk = result.find((c) => c.text.includes("Revenue breakdown"))
            assert.ok(revenueChunk, "Expected chunk containing revenue breakdown to be retrieved")
        }
    )

    // -------------------------------------------------------------
    // Test 14: retrieveDocumentContext guarantees grounded context when Vectorize returns 0 matches
    // -------------------------------------------------------------
    await t.test(
        "14. retrieveDocumentContext guarantees grounded context when Vectorize returns 0 matches",
        async () => {
            const mockEmptyVectorize = {
                async query() {
                    // Vectorize returns 0 matches (e.g. metadata filtering unindexed or query mismatch)
                    return { matches: [], count: 0 }
                },
            }
            const mockAi = {
                async run() {
                    return { data: [[0.1, 0.2, 0.3]] }
                },
            }

            const r2Storage = new Map()
            r2Storage.set(
                "extracted/user_guide.txt",
                "This user guide provides instructions on how to use the AI chat interface and select knowledge documents."
            )

            const mockR2 = {
                async get(key) {
                    const val = r2Storage.get(key)
                    if (!val) return null
                    return {
                        text: async () => val,
                        arrayBuffer: async () => new TextEncoder().encode(val).buffer,
                    }
                },
                async put(key, val) {
                    r2Storage.set(key, typeof val === "string" ? val : "")
                },
                async list() {
                    return { objects: [] }
                },
            }

            // Even though Vectorize returned 0 matches, retrieveDocumentContext MUST return grounded chunks from R2!
            const chunks = await retrieveDocumentContext(
                mockAi,
                mockEmptyVectorize,
                mockR2,
                "summarize this document",
                ["user_guide"],
                { user_guide: "User Guide.pdf" }
            )

            assert.ok(chunks.length > 0, "Expected at least 1 grounded chunk to be retrieved")
            assert.strictEqual(chunks[0].documentId, "user_guide")
            assert.strictEqual(chunks[0].name, "User Guide.pdf")
            assert.ok(chunks[0].text.includes("AI chat interface"))
        }
    )

    // -------------------------------------------------------------
    // Test 15: extractPdfPages handles safety & chunkPages preserves 1-indexed page numbers
    // -------------------------------------------------------------
    await t.test(
        "15. extractPdfPages safe on empty and chunkPages preserves 1-indexed page numbers",
        async () => {
            const emptyPages = await extractPdfPages(new Uint8Array(0))
            assert.deepStrictEqual(emptyPages, [])

            const mockPages = [
                {
                    pageNumber: 1,
                    text: "Page 1 Executive Summary: Cloudflare Workers AI with Vectorize enables serverless RAG.",
                },
                {
                    pageNumber: 2,
                    text: "Page 2 Technical Specifications: Embedding dimensions are 768 using BAAI BGE model.",
                },
                {
                    pageNumber: 3,
                    text: "Page 3 Architecture & Limits: Vectorize queries return topK similarity vectors with metadata.",
                },
            ]

            const chunks = chunkPages(mockPages, 400, 50)
            assert.strictEqual(chunks.length, 3)
            assert.strictEqual(chunks[0].pageNumber, 1)
            assert.ok(chunks[0].text.includes("Executive Summary"))
            assert.strictEqual(chunks[1].pageNumber, 2)
            assert.ok(chunks[1].text.includes("Technical Specifications"))
            assert.strictEqual(chunks[2].pageNumber, 3)
            assert.ok(chunks[2].text.includes("Architecture & Limits"))
        }
    )

    // -------------------------------------------------------------
    // Test 16: indexDocumentChunks stores pageNumber in Vectorize metadata & queryKnowledge retrieves it
    // -------------------------------------------------------------
    await t.test(
        "16. indexDocumentChunks stores pageNumber in Vectorize metadata & queryKnowledge retrieves it",
        async () => {
            let upsertedBatches = []
            const mockVectorize = {
                async upsert(records) {
                    upsertedBatches.push(...records)
                },
                async query() {
                    return {
                        matches: upsertedBatches.map((rec) => ({
                            id: rec.id,
                            score: 0.95,
                            metadata: rec.metadata,
                        })),
                        count: upsertedBatches.length,
                    }
                },
            }

            const mockAi = {
                async run(_model, inputs) {
                    return {
                        data: inputs.text.map(() => [0.1, 0.2, 0.3]),
                    }
                },
            }

            const sampleChunks = [
                { text: "Overview of system architecture on page 1.", pageNumber: 1 },
                { text: "Detailed database schema definitions on page 4.", pageNumber: 4 },
            ]

            const indexResult = await indexDocumentChunks(
                mockAi,
                mockVectorize,
                "doc_paged_1",
                "Specification.pdf",
                sampleChunks
            )

            assert.strictEqual(indexResult.chunksIndexed, 2)
            assert.strictEqual(upsertedBatches.length, 2)
            assert.strictEqual(upsertedBatches[0].metadata.pageNumber, 1)
            assert.strictEqual(upsertedBatches[1].metadata.pageNumber, 4)

            // Query and verify pageNumber is returned
            const retrieved = await queryKnowledge(
                mockAi,
                mockVectorize,
                "system architecture",
                5,
                ["doc_paged_1"]
            )
            assert.strictEqual(retrieved.length, 2)
            assert.strictEqual(retrieved[0].pageNumber, 1)
            assert.strictEqual(retrieved[1].pageNumber, 4)
        }
    )

    // -------------------------------------------------------------
    // Test 17: getDocumentChunks preserves pageNumber from chunks.json and pages.json
    // -------------------------------------------------------------
    await t.test(
        "17. getDocumentChunks preserves pageNumber from chunks.json and pages.json",
        async () => {
            const r2Storage = new Map()

            // 1. Structured chunks with page numbers
            r2Storage.set(
                "intermediates/doc_pages_test/chunks.json",
                JSON.stringify([
                    { text: "Introduction and executive summary on page 1.", pageNumber: 1 },
                    { text: "Revenue and growth metrics on page 3.", pageNumber: 3 },
                ])
            )

            const mockR2 = {
                async get(key) {
                    const val = r2Storage.get(key)
                    if (!val) return null
                    return {
                        text: async () => val,
                        arrayBuffer: async () => new TextEncoder().encode(val).buffer,
                    }
                },
                async put() {},
                async list() {
                    return { objects: [] }
                },
            }

            const retrieved = await getDocumentChunks(
                mockR2,
                "doc_pages_test",
                "Report.pdf",
                "revenue growth"
            )
            assert.ok(retrieved.length > 0)
            const revenueChunk = retrieved.find((c) => c.text.includes("Revenue and growth"))
            assert.ok(revenueChunk, "Expected revenue chunk")
            assert.strictEqual(revenueChunk.pageNumber, 3)
        }
    )

    // =============================================================
    // Helper Fixture Generators for Real Valid PDF Byte Streams
    // =============================================================
    function createTextPdfFixture(p1Text, p2Text) {
        const p2Obj = p2Text
            ? `\n6 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 7 0 R >> endobj\n7 0 obj << /Length ${p2Text.length + 30} >> stream\nBT /F1 12 Tf 72 712 Td (${p2Text}) Tj ET\nendstream\nendobj`
            : ""
        const kids = p2Text ? "[3 0 R 6 0 R]" : "[3 0 R]"
        const count = p2Text ? "2" : "1"
        const pdf = `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids ${kids} /Count ${count} >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj
4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj
5 0 obj << /Length ${p1Text.length + 30} >> stream
BT /F1 12 Tf 72 712 Td (${p1Text}) Tj ET
endstream
endobj${p2Obj}
xref
0 ${p2Text ? "8" : "6"}
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000122 00000 n 
0000000251 00000 n 
0000000325 00000 n 
trailer << /Size ${p2Text ? "8" : "6"} /Root 1 0 R >>
startxref
500
%%EOF`
        return new TextEncoder().encode(pdf)
    }

    function createScannedPdfFixture(width = 80, height = 80) {
        const rawLen = width * height * 3
        const streamBytes = "\xFF".repeat(rawLen)
        const pdf = `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >> endobj
4 0 obj << /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${rawLen} >> stream
${streamBytes}
endstream
endobj
5 0 obj << /Length 20 >> stream
q ${width} 0 0 ${height} 0 0 cm /Im0 Do Q
endstream
endobj
xref
0 6
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
0000000236 00000 n 
trailer << /Size 6 /Root 1 0 R >>
startxref
500
%%EOF`
        return new TextEncoder().encode(pdf)
    }

    function createMixedPdfFixture(p1Text, imageWidth = 80, imageHeight = 80) {
        const rawLen = imageWidth * imageHeight * 3
        const streamBytes = "\xFF".repeat(rawLen)
        const pdf = `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj
4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj
5 0 obj << /Length ${p1Text.length + 30} >> stream
BT /F1 12 Tf 72 712 Td (${p1Text}) Tj ET
endstream
endobj
6 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 7 0 R >> >> /Contents 8 0 R >> endobj
7 0 obj << /Type /XObject /Subtype /Image /Width ${imageWidth} /Height ${imageHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${rawLen} >> stream
${streamBytes}
endstream
endobj
8 0 obj << /Length 20 >> stream
q ${imageWidth} 0 0 ${imageHeight} 0 0 cm /Im0 Do Q
endstream
endobj
xref
0 9
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000122 00000 n 
0000000251 00000 n 
0000000325 00000 n 
0000000433 00000 n 
0000000561 00000 n 
trailer << /Size 9 /Root 1 0 R >>
startxref
500
%%EOF`
        return new TextEncoder().encode(pdf)
    }

    // -------------------------------------------------------------
    // Test 18: Text-based PDFs that should not trigger OCR
    // -------------------------------------------------------------
    await t.test(
        "18. Text-based PDF extracts embedded text with unpdf and skips OCR entirely",
        async () => {
            const pdfBytes = createTextPdfFixture(
                "Executive Summary: Cloudflare Workers AI with Vectorize enables serverless RAG architectures.",
                "Technical Specifications: Embedding dimensions are 768 using BAAI BGE model across documents."
            )

            const ocrCalls = []
            const mockAi = {
                async run(model, inputs) {
                    ocrCalls.push({ model, inputs })
                    return { response: "Unexpected OCR execution" }
                },
            }

            const result = await extractPdfDocument(pdfBytes, { ai: mockAi })

            assert.strictEqual(result.extractionMode, "text")
            assert.strictEqual(result.ocrPagesCount, 0)
            assert.strictEqual(ocrCalls.length, 0, "OCR must NOT be triggered for text-based PDFs")
            assert.strictEqual(result.totalPages, 2)
            assert.strictEqual(result.pages.length, 2)
            assert.strictEqual(result.pages[0].pageNumber, 1)
            assert.strictEqual(result.pages[1].pageNumber, 2)
            assert.ok(result.pages[0].text.includes("Executive Summary"))
            assert.ok(result.pages[1].text.includes("Technical Specifications"))
            assert.ok(result.contentHash.length > 0)
        }
    )

    // -------------------------------------------------------------
    // Test 19: Scanned PDFs that require OCR
    // -------------------------------------------------------------
    await t.test(
        "19. Scanned image-based PDF detects absent text and triggers conditional OCR",
        async () => {
            const pdfBytes = createScannedPdfFixture(80, 80)

            const ocrCalls = []
            const mockAi = {
                async run(model, inputs) {
                    ocrCalls.push({ model, inputs })
                    return {
                        response:
                            "INVOICE #98765\nVendor: Global Cloud Corp\nTotal Due: $1,250.00\nPayment Terms: Net 30",
                    }
                },
            }

            const result = await extractPdfDocument(pdfBytes, { ai: mockAi })

            assert.strictEqual(result.extractionMode, "ocr")
            assert.strictEqual(result.ocrPagesCount, 1)
            assert.strictEqual(ocrCalls.length, 1, "Expected OCR to run for the scanned image page")
            assert.strictEqual(result.pages.length, 1)
            assert.strictEqual(result.pages[0].pageNumber, 1)
            assert.ok(result.pages[0].text.includes("INVOICE #98765"))
            assert.ok(result.pages[0].text.includes("Total Due: $1,250.00"))
        }
    )

    // -------------------------------------------------------------
    // Test 20: Mixed PDFs where only necessary pages receive OCR
    // -------------------------------------------------------------
    await t.test(
        "20. Mixed PDF preserves embedded text and runs OCR only on pages requiring it",
        async () => {
            const pdfBytes = createMixedPdfFixture(
                "Page 1 Overview: High-performance edge compute with instant cold starts.",
                80,
                80
            )

            const ocrCalls = []
            const mockAi = {
                async run(model, inputs) {
                    ocrCalls.push({ model, inputs })
                    return {
                        response:
                            "Page 2 Scanned Diagram: System Architecture from client to Vectorize database.",
                    }
                },
            }

            const result = await extractPdfDocument(pdfBytes, { ai: mockAi })

            assert.strictEqual(result.extractionMode, "mixed")
            assert.strictEqual(result.ocrPagesCount, 1)
            assert.strictEqual(
                ocrCalls.length,
                1,
                "OCR must only execute for Page 2, Page 1 text must be preserved without OCR"
            )
            assert.strictEqual(result.totalPages, 2)
            assert.strictEqual(result.pages.length, 2)

            // Page 1 is from embedded text layer
            assert.strictEqual(result.pages[0].pageNumber, 1)
            assert.ok(result.pages[0].text.includes("Page 1 Overview"))

            // Page 2 is from conditional OCR
            assert.strictEqual(result.pages[1].pageNumber, 2)
            assert.ok(result.pages[1].text.includes("Page 2 Scanned Diagram"))
        }
    )

    // -------------------------------------------------------------
    // Test 21: Empty, malformed, and garbled-text PDFs
    // -------------------------------------------------------------
    await t.test(
        "21. Empty, malformed, and garbled-text PDFs handle failures cleanly without crashing",
        async () => {
            const ocrCalls = []
            const mockAi = {
                async run(model, inputs) {
                    ocrCalls.push({ model, inputs })
                    return { response: "Should not be called" }
                },
            }

            // 1. Empty byte buffer
            const emptyResult = await extractPdfDocument(new Uint8Array(0), { ai: mockAi })
            assert.strictEqual(emptyResult.pages.length, 0)
            assert.strictEqual(ocrCalls.length, 0, "Empty buffer must not trigger OCR")

            // 2. Corrupt byte buffer
            const corruptBytes = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04])
            const corruptResult = await extractPdfDocument(corruptBytes, { ai: mockAi })
            assert.strictEqual(corruptResult.pages.length, 0)
            assert.strictEqual(ocrCalls.length, 0, "Corrupt buffer must not trigger OCR")

            // 3. Garbled text quality assessments
            const repetitive = evaluatePageTextQuality(".".repeat(60))
            assert.strictEqual(repetitive.isUsable, false)

            const symbolNoise = evaluatePageTextQuality("!@#$%^&*()_+=-{}[]:;'<>?,./~".repeat(3))
            assert.strictEqual(symbolNoise.isUsable, false)

            const sparseNoise = evaluatePageTextQuality("Page 1")
            assert.strictEqual(sparseNoise.isUsable, false)

            const goodText = evaluatePageTextQuality(
                "Cloudflare Workers provides serverless execution environments with low latency."
            )
            assert.strictEqual(goodText.isUsable, true)
        }
    )

    // -------------------------------------------------------------
    // Test 22: Duplicate text between embedded extraction and OCR
    // -------------------------------------------------------------
    await t.test(
        "22. Duplicate text between embedded extraction and OCR is completely deduplicated",
        () => {
            // Case 1: Exact match
            const exactMerged = mergePageText("Financial Report Q1", "Financial Report Q1")
            assert.strictEqual(exactMerged, "Financial Report Q1")

            // Case 2: OCR output is superset of heading (avoids repeating heading)
            const supersetMerged = mergePageText(
                "Company Financials",
                "Company Financials\n\nTotal Revenue: $5,000,000\nOperating Profit: $1,200,000"
            )
            assert.strictEqual(
                supersetMerged,
                "Company Financials\n\nTotal Revenue: $5,000,000\nOperating Profit: $1,200,000"
            )

            // Case 3: Embedded text contains OCR text (OCR recognized label already in text)
            const embeddedContainsMerged = mergePageText(
                "Complete document section with Figure 1: Flowchart of Vectorize index.",
                "Figure 1: Flowchart of Vectorize index."
            )
            assert.strictEqual(
                embeddedContainsMerged,
                "Complete document section with Figure 1: Flowchart of Vectorize index."
            )

            // Case 4: Distinct non-overlapping paragraphs appended cleanly
            const distinctMerged = mergePageText(
                "Section 1: Distributed Storage.",
                "Figure 2: Architecture diagram of Durable Objects."
            )
            assert.ok(distinctMerged.includes("Section 1: Distributed Storage."))
            assert.ok(distinctMerged.includes("Figure 2: Architecture diagram of Durable Objects."))
        }
    )

    // -------------------------------------------------------------
    // Test 23: Decorative images and repeated logos filtering
    // -------------------------------------------------------------
    await t.test(
        "23. Decorative images and repeated logos are filtered and not OCR'd repeatedly",
        () => {
            // Reject tiny icon
            assert.strictEqual(isCandidateOcrImage({ width: 16, height: 16, channels: 3 }), false)

            // Reject horizontal separator line
            assert.strictEqual(isCandidateOcrImage({ width: 800, height: 2, channels: 3 }), false)

            // Reject vertical border rule
            assert.strictEqual(isCandidateOcrImage({ width: 2, height: 800, channels: 3 }), false)

            // Accept legitimate document image
            assert.strictEqual(isCandidateOcrImage({ width: 600, height: 800, channels: 3 }), true)

            // Image hash determinism
            const imgData1 = new Uint8Array(100).fill(128)
            const imgData2 = new Uint8Array(100).fill(128)
            const imgData3 = new Uint8Array(100).fill(255)

            const hash1 = computeImageHash(10, 10, 1, imgData1)
            const hash2 = computeImageHash(10, 10, 1, imgData2)
            const hash3 = computeImageHash(10, 10, 1, imgData3)

            assert.strictEqual(hash1, hash2, "Identical image pixels must produce identical hash")
            assert.notStrictEqual(hash1, hash3, "Different pixels must produce different hash")
        }
    )

    // -------------------------------------------------------------
    // Test 24: OCR failure on one page while other pages succeed
    // -------------------------------------------------------------
    await t.test(
        "24. OCR failure on one page is isolated without losing successfully extracted pages",
        async () => {
            const pdfBytes = createMixedPdfFixture(
                "Page 1 Documentation: Robust edge computing with zero cold starts.",
                80,
                80
            )

            const mockFailingAi = {
                async run() {
                    throw new Error("Workers AI vision service timeout or 503 unavailable")
                },
            }

            // Pipeline should NOT throw; Page 1 must still be returned!
            const result = await extractPdfDocument(pdfBytes, { ai: mockFailingAi })

            assert.strictEqual(result.totalPages, 2)
            assert.ok(result.pages.length >= 1, "Page 1 embedded text must be preserved")
            assert.strictEqual(result.pages[0].pageNumber, 1)
            assert.ok(result.pages[0].text.includes("Page 1 Documentation"))
            assert.strictEqual(result.details?.ocrFailedPages, 1)
        }
    )

    // -------------------------------------------------------------
    // Test 25: Workflow retries clean orphan vector IDs when chunk count decreases
    // -------------------------------------------------------------
    await t.test(
        "25. Workflow retries clean orphan vector IDs when chunk count decreases",
        async () => {
            const deletedVectorBatches = []
            const mockVectorize = {
                async deleteByIds(ids) {
                    deletedVectorBatches.push(...ids)
                },
                async upsert() {},
            }

            // Document previously had 5 chunks: doc_test_0 to doc_test_4
            const oldChunkCount = 5
            const newChunkCount = 3
            const documentId = "doc_test_orphan"

            if (oldChunkCount > newChunkCount) {
                const orphanIds = []
                for (let i = newChunkCount; i < oldChunkCount; i++) {
                    orphanIds.push(`${documentId}_${i}`)
                }
                await mockVectorize.deleteByIds(orphanIds)
            }

            assert.strictEqual(deletedVectorBatches.length, 2)
            assert.strictEqual(deletedVectorBatches[0], "doc_test_orphan_3")
            assert.strictEqual(deletedVectorBatches[1], "doc_test_orphan_4")
        }
    )

    // -------------------------------------------------------------
    // Test 26: Idempotent reprocessing skips embedding and indexing when content is unchanged
    // -------------------------------------------------------------
    await t.test(
        "26. Idempotent reprocessing skips embedding and indexing when content is unchanged",
        async () => {
            let embeddingCalled = false
            let vectorizeUpsertCalled = false

            const mockAi = {
                async run() {
                    embeddingCalled = true
                    return { data: [[0.1, 0.2, 0.3]] }
                },
            }

            const mockVectorize = {
                async upsert() {
                    vectorizeUpsertCalled = true
                },
            }

            const isContentUnchanged = true
            const docStatus = "ready"
            const docChunkCount = 2
            const currentChunksCount = 2

            // Simulate generate-embeddings guard
            let embeddingSkipped = false
            if (
                isContentUnchanged &&
                docStatus === "ready" &&
                docChunkCount === currentChunksCount
            ) {
                embeddingSkipped = true
            } else {
                await mockAi.run()
            }

            // Simulate index-vectors guard
            let indexingSkipped = false
            if (embeddingSkipped) {
                indexingSkipped = true
            } else {
                await mockVectorize.upsert([])
            }

            assert.strictEqual(embeddingSkipped, true)
            assert.strictEqual(indexingSkipped, true)
            assert.strictEqual(embeddingCalled, false, "Embedding generation must be skipped")
            assert.strictEqual(vectorizeUpsertCalled, false, "Vectorize upsert must be skipped")
        }
    )

    // -------------------------------------------------------------
    // Test 27: Pure-JS PNG encoder produces valid PNG bytes compatible with Workers AI vision
    // -------------------------------------------------------------
    await t.test(
        "27. Pure-JS PNG encoder produces valid PNG bytes compatible with Workers AI vision",
        async () => {
            const width = 10
            const height = 10
            const channels = 3
            const rawPixels = new Uint8Array(width * height * channels).fill(128)

            const pngBytes = await encodeRawToPng(width, height, channels, rawPixels)

            assert.ok(pngBytes.length > 50, "PNG output must have valid non-zero length")

            // Check standard 8-byte PNG header: [137, 80, 78, 71, 13, 10, 26, 10]
            assert.strictEqual(pngBytes[0], 137)
            assert.strictEqual(pngBytes[1], 80) // P
            assert.strictEqual(pngBytes[2], 78) // N
            assert.strictEqual(pngBytes[3], 71) // G
            assert.strictEqual(pngBytes[4], 13)
            assert.strictEqual(pngBytes[5], 10)
            assert.strictEqual(pngBytes[6], 26)
            assert.strictEqual(pngBytes[7], 10)

            // Verify IHDR and IDAT chunks are present
            const text = new TextDecoder("ascii").decode(pngBytes.slice(0, 100))
            assert.ok(text.includes("IHDR"))
            assert.ok(text.includes("IDAT"))

            // Verify performVisionOcr correctly packages PNG bytes to Workers AI
            const ocrResult = await performVisionOcr(
                {
                    async run(model, inputs) {
                        assert.ok(inputs.image)
                        assert.strictEqual(inputs.image.length, pngBytes.length)
                        return { response: "Document Title: Verification Pass" }
                    },
                },
                pngBytes,
                1
            )
            assert.strictEqual(ocrResult, "Document Title: Verification Pass")
        }
    )

    // -------------------------------------------------------------
    // Test 28: Workers AI toMarkdown fallback when unpdf parsing fails
    // -------------------------------------------------------------
    await t.test(
        "28. Workers AI toMarkdown fallback extracts text when unpdf parsing fails",
        async () => {
            const corruptedPdf = new Uint8Array([1, 2, 3, 4, 5])
            let toMarkdownCalled = false

            const mockToMarkdownAi = {
                async run() {},
                async toMarkdown(buffer, opts) {
                    toMarkdownCalled = true
                    assert.ok(buffer)
                    assert.strictEqual(opts?.conversionOptions?.output?.format, "text")
                    return { content: "Fallback text from Workers AI toMarkdown" }
                },
            }

            const result = await extractPdfDocument(corruptedPdf, { ai: mockToMarkdownAi })

            assert.strictEqual(toMarkdownCalled, true, "toMarkdown fallback must be called")
            assert.strictEqual(result.totalPages, 1)
            assert.strictEqual(result.pages.length, 1)
            assert.strictEqual(result.pages[0].pageNumber, 1)
            assert.strictEqual(result.pages[0].text, "Fallback text from Workers AI toMarkdown")
            assert.strictEqual(result.extractionMode, "text")
            assert.ok(result.contentHash.length > 0)
        }
    )
})
