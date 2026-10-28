import test from "node:test"
import assert from "node:assert/strict"
import util from "node:util"
import { env } from "cloudflare:workers"

import { GET } from "../src/app/api/files/[id]/progress/route.ts"
import { DocumentProgressDO } from "../src/lib/durable-object.ts"
import { SSE_HEADERS } from "../src/lib/sse.ts"

function createMockStorage() {
    const map = new Map()
    return {
        map,
        storage: {
            async get(key) {
                return map.get(key)
            },
            async put(entriesOrKey, maybeVal) {
                if (typeof entriesOrKey === "object") {
                    for (const [k, v] of Object.entries(entriesOrKey)) {
                        map.set(k, v)
                    }
                } else {
                    map.set(entriesOrKey, maybeVal)
                }
            },
        },
    }
}

function createMockD1(documents = new Map()) {
    return {
        prepare(_sql) {
            return {
                bind(...args) {
                    const docId = args[0]
                    return {
                        async first() {
                            return documents.get(docId) || null
                        },
                    }
                },
            }
        },
    }
}

test("Durable Object SSE & Progress Route Forwarding Suite", async (t) => {
    const TEST_PIN = "9876"
    env.APP_PIN = TEST_PIN

    await t.test(
        "1. Catches original defect: Proxied request forwarded directly triggers 'TypeError: Invalid URL: [object Request]', while normalized forwarding succeeds",
        async () => {
            const { storage } = createMockStorage()
            const mockCtx = {
                storage,
                blockConcurrencyWhile: async (fn) => await fn(),
            }
            const doInstance = new DocumentProgressDO(mockCtx, {})

            // Emulate workerd's C++ DurableObjectStub.fetch behavior:
            // workerd attempts to unwrap a native C++ Request. When given a JS Proxy,
            // the unwrap fails and workerd falls back to stringifying the input as a URL,
            // yielding "[object Request]" which fails URL parsing with:
            // TypeError: Invalid URL: [object Request]
            const mockStub = {
                async fetch(input, init) {
                    if (util.types.isProxy(input)) {
                        const coerced = String(input) // "[object Request]"
                        try {
                            new URL(coerced)
                        } catch {
                            throw new TypeError(`Invalid URL: ${coerced}`)
                        }
                    }
                    return await doInstance.fetch(input, init)
                },
            }

            // Direct call with a proxy simulates the PRE-FIX line: await stub.fetch(req)
            const rawReq = new Request("http://localhost/api/files/doc_bug/progress")
            const proxiedReq = new Proxy(rawReq, {
                get(target, prop) {
                    const val = Reflect.get(target, prop, target)
                    return typeof val === "function" ? val.bind(target) : val
                },
            })

            // Confirm that the simulated workerd stub catches the original bug
            await assert.rejects(
                async () => {
                    await mockStub.fetch(proxiedReq)
                },
                {
                    name: "TypeError",
                    message: "Invalid URL: [object Request]",
                }
            )

            // Now test through the fixed GET route handler:
            // The route unwraps and constructs a clean Request with an internal URL
            const docs = new Map([
                [
                    "doc_bug",
                    {
                        id: "doc_bug",
                        status: "processing",
                        stage: "extraction",
                        progress: 15,
                    },
                ],
            ])
            env.DB = createMockD1(docs)
            env.DOCUMENT_PROGRESS_DO = {
                idFromName: (name) => ({ name }),
                get: (_id) => mockStub,
            }

            const routeReq = new Proxy(
                new Request("http://localhost/api/files/doc_bug/progress", {
                    headers: { "x-app-pin": TEST_PIN },
                }),
                {
                    get(target, prop) {
                        const val = Reflect.get(target, prop, target)
                        return typeof val === "function" ? val.bind(target) : val
                    },
                }
            )

            const res = await GET(routeReq, { params: Promise.resolve({ id: "doc_bug" }) })
            assert.strictEqual(res.status, 200, "Fixed route must return 200 OK")
            assert.strictEqual(
                res.headers.get("Content-Type"),
                "text/event-stream; charset=utf-8",
                "Fixed route must return SSE stream"
            )

            doInstance.closeAll()
        }
    )

    await t.test(
        "2. Valid progress Request reaches Durable Object and returns working SSE stream with expected headers",
        async () => {
            const { storage } = createMockStorage()
            const mockCtx = {
                storage,
                blockConcurrencyWhile: async (fn) => await fn(),
            }
            const doInstance = new DocumentProgressDO(mockCtx, {})

            const docs = new Map([
                [
                    "doc_valid",
                    {
                        id: "doc_valid",
                        status: "processing",
                        stage: "chunking",
                        progress: 35,
                    },
                ],
            ])
            env.DB = createMockD1(docs)
            env.DOCUMENT_PROGRESS_DO = {
                idFromName: (name) => ({ name }),
                get: (_id) => ({
                    fetch: (input, init) => doInstance.fetch(input, init),
                }),
            }

            const req = new Request("http://localhost/api/files/doc_valid/progress", {
                headers: { "x-app-pin": TEST_PIN },
            })
            const res = await GET(req, { params: Promise.resolve({ id: "doc_valid" }) })

            assert.strictEqual(res.status, 200)
            assert.strictEqual(res.headers.get("Content-Type"), SSE_HEADERS["Content-Type"])
            assert.strictEqual(res.headers.get("Cache-Control"), SSE_HEADERS["Cache-Control"])
            assert.strictEqual(res.headers.get("Connection"), SSE_HEADERS["Connection"])
            assert.ok(res.body, "Response must have a readable stream body")

            doInstance.closeAll()
        }
    )

    await t.test(
        "3. SSE stream delivers live progress events correctly without buffering or JSON conversion",
        async () => {
            const { storage } = createMockStorage()
            const mockCtx = {
                storage,
                blockConcurrencyWhile: async (fn) => await fn(),
            }
            const doInstance = new DocumentProgressDO(mockCtx, {})

            const docs = new Map([
                [
                    "doc_stream",
                    {
                        id: "doc_stream",
                        status: "processing",
                        stage: "embedding",
                        progress: 50,
                    },
                ],
            ])
            env.DB = createMockD1(docs)
            env.DOCUMENT_PROGRESS_DO = {
                idFromName: (name) => ({ name }),
                get: (_id) => ({
                    fetch: (input, init) => doInstance.fetch(input, init),
                }),
            }

            const req = new Request("http://localhost/api/files/doc_stream/progress", {
                headers: { "x-app-pin": TEST_PIN },
            })
            const res = await GET(req, { params: Promise.resolve({ id: "doc_stream" }) })
            assert.strictEqual(res.status, 200)

            const reader = res.body.getReader()
            const decoder = new TextDecoder()

            // Trigger a live progress event from Workflow
            const now = Date.now()
            await doInstance.reportProgress({
                documentId: "doc_stream",
                status: "processing",
                stage: "indexing",
                progress: 80,
                message: "Indexing vectors",
                timestamp: now,
            })

            const { value, done } = await reader.read()
            assert.strictEqual(done, false)
            const text = decoder.decode(value)

            assert.ok(text.includes("id: 1"))
            assert.ok(text.includes("event: progress"))
            assert.ok(text.includes('"stage":"indexing"'))
            assert.ok(text.includes('"progress":80'))

            doInstance.closeAll()
        }
    )

    await t.test(
        "4. Last-Event-ID header is preserved on reconnect and triggers history replay",
        async () => {
            const { storage } = createMockStorage()
            const mockCtx = {
                storage,
                blockConcurrencyWhile: async (fn) => await fn(),
            }
            const doInstance = new DocumentProgressDO(mockCtx, {})

            // Seed 3 events
            await doInstance.reportProgress({
                documentId: "doc_reconnect",
                status: "processing",
                stage: "extraction",
                progress: 10,
                timestamp: 1000,
            })
            await doInstance.reportProgress({
                documentId: "doc_reconnect",
                status: "processing",
                stage: "chunking",
                progress: 30,
                timestamp: 2000,
            })
            await doInstance.reportProgress({
                documentId: "doc_reconnect",
                status: "processing",
                stage: "embedding",
                progress: 60,
                timestamp: 3000,
            })

            const docs = new Map([
                [
                    "doc_reconnect",
                    {
                        id: "doc_reconnect",
                        status: "processing",
                        stage: "embedding",
                        progress: 60,
                    },
                ],
            ])
            env.DB = createMockD1(docs)
            env.DOCUMENT_PROGRESS_DO = {
                idFromName: (name) => ({ name }),
                get: (_id) => ({
                    fetch: (input, init) => doInstance.fetch(input, init),
                }),
            }

            // Client reconnects claiming it has already seen event seq 2
            const req = new Request("http://localhost/api/files/doc_reconnect/progress", {
                headers: {
                    "x-app-pin": TEST_PIN,
                    "Last-Event-ID": "2",
                },
            })

            const res = await GET(req, { params: Promise.resolve({ id: "doc_reconnect" }) })
            assert.strictEqual(res.status, 200)

            const reader = res.body.getReader()
            const decoder = new TextDecoder()
            const { value } = await reader.read()
            const text = decoder.decode(value)

            // Replay should contain id: 3 only, NOT id: 1 or id: 2
            assert.ok(text.includes("id: 3"))
            assert.ok(text.includes('"stage":"embedding"'))
            assert.ok(!text.includes("id: 1\n"))
            assert.ok(!text.includes("id: 2\n"))

            doInstance.closeAll()
        }
    )

    await t.test(
        "5. Unauthorized requests and nonexistent documents remain rejected before DO allocation",
        async () => {
            let doContacted = false
            env.DOCUMENT_PROGRESS_DO = {
                idFromName: () => {
                    doContacted = true
                    return {}
                },
                get: () => {
                    doContacted = true
                    return {}
                },
            }

            const docs = new Map([
                ["doc_exists", { id: "doc_exists", status: "processing", progress: 10 }],
            ])
            env.DB = createMockD1(docs)

            // 1. Missing or invalid PIN -> 401
            const unauthReq = new Request("http://localhost/api/files/doc_exists/progress", {
                headers: { "x-app-pin": "wrong-pin" },
            })
            const unauthRes = await GET(unauthReq, {
                params: Promise.resolve({ id: "doc_exists" }),
            })
            assert.strictEqual(unauthRes.status, 401)
            const unauthJson = await unauthRes.json()
            assert.ok(unauthJson.error.includes("Unauthorized"))
            assert.strictEqual(doContacted, false, "DO must not be contacted for 401")

            // 2. Nonexistent document -> 404
            const notFoundReq = new Request("http://localhost/api/files/doc_missing/progress", {
                headers: { "x-app-pin": TEST_PIN },
            })
            const notFoundRes = await GET(notFoundReq, {
                params: Promise.resolve({ id: "doc_missing" }),
            })
            assert.strictEqual(notFoundRes.status, 404)
            const notFoundJson = await notFoundRes.json()
            assert.strictEqual(notFoundJson.error, "Document not found")
            assert.strictEqual(doContacted, false, "DO must not be contacted for 404")
        }
    )

    await t.test(
        "6. Client cancellation does not leave the connection registered indefinitely",
        async () => {
            const { storage } = createMockStorage()
            const mockCtx = {
                storage,
                blockConcurrencyWhile: async (fn) => await fn(),
            }
            const doInstance = new DocumentProgressDO(mockCtx, {})

            const docs = new Map([
                ["doc_abort", { id: "doc_abort", status: "processing", progress: 10 }],
            ])
            env.DB = createMockD1(docs)
            env.DOCUMENT_PROGRESS_DO = {
                idFromName: (name) => ({ name }),
                get: (_id) => ({
                    fetch: (input, init) => doInstance.fetch(input, init),
                }),
            }

            const abortController = new AbortController()
            const req = new Request("http://localhost/api/files/doc_abort/progress", {
                headers: { "x-app-pin": TEST_PIN },
                signal: abortController.signal,
            })

            const res = await GET(req, { params: Promise.resolve({ id: "doc_abort" }) })
            assert.strictEqual(res.status, 200)

            // Verify client is initially connected in DO
            assert.strictEqual(doInstance.connectedClients.size, 1)

            // Trigger client cancellation
            abortController.abort()

            // Small tick for event listener
            await new Promise((r) => setTimeout(r, 15))

            // The writer must be cleaned up and client count must be 0
            assert.strictEqual(doInstance.connectedClients.size, 0)

            doInstance.closeAll()
        }
    )
})
