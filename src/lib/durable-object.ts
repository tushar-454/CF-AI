import { DurableObject } from "cloudflare:workers"
import type { AppEnv, DocumentProgressEvent } from "./types"
import { SSE_HEADERS } from "./sse"

interface StoredEventRecord {
    id: number
    event: DocumentProgressEvent
}

export class DocumentProgressDO extends DurableObject<AppEnv> {
    private connectedClients: Set<WritableStreamDefaultWriter<Uint8Array>> = new Set()
    private encoder = new TextEncoder()
    private heartbeatTimer: ReturnType<typeof setInterval> | null = null
    private currentSeq: number = 0
    private initialized: boolean = false

    constructor(ctx: DurableObjectState, env: AppEnv) {
        super(ctx, env)
        // Ensure persisted sequence is restored before processing any RPC or fetch requests
        if (typeof ctx.blockConcurrencyWhile === "function") {
            void ctx.blockConcurrencyWhile(async () => {
                await this.loadInitialState()
            })
        }
    }

    private async loadInitialState(): Promise<void> {
        if (this.initialized) return
        const latestSeq = (await this.ctx.storage.get<number>("latest_seq")) || 0
        this.currentSeq = Math.max(this.currentSeq, latestSeq)
        this.initialized = true
    }

    private ensureInitialized(): Promise<void> {
        if (this.initialized) return Promise.resolve()
        return this.loadInitialState()
    }

    private startHeartbeatIfNeeded() {
        if (this.heartbeatTimer !== null || this.connectedClients.size === 0) return

        this.heartbeatTimer = setInterval(() => {
            if (this.connectedClients.size === 0) {
                if (this.heartbeatTimer) {
                    clearInterval(this.heartbeatTimer)
                    this.heartbeatTimer = null
                }
                return
            }
            const pingBytes = this.encoder.encode(": ping\n\n")
            for (const writer of Array.from(this.connectedClients)) {
                writer.write(pingBytes).catch(() => {
                    this.removeClient(writer)
                })
            }
        }, 15000)

        if (
            this.heartbeatTimer &&
            typeof (this.heartbeatTimer as { unref?: () => void }).unref === "function"
        ) {
            ;(this.heartbeatTimer as { unref: () => void }).unref()
        }
    }

    closeAll() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer)
            this.heartbeatTimer = null
        }
        for (const writer of Array.from(this.connectedClients)) {
            this.removeClient(writer)
        }
    }

    private removeClient(writer: WritableStreamDefaultWriter<Uint8Array>) {
        this.connectedClients.delete(writer)
        try {
            writer.close().catch(() => {})
        } catch {}
        if (this.connectedClients.size === 0 && this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer)
            this.heartbeatTimer = null
        }
    }

    /**
     * Internal method called via RPC from Workflow or Worker
     */
    async reportProgress(event: DocumentProgressEvent): Promise<void> {
        await this.ensureInitialized()
        this.currentSeq++
        const seq = this.currentSeq

        const history: StoredEventRecord[] =
            (await this.ctx.storage.get<StoredEventRecord[]>("event_history")) || []
        history.push({ id: seq, event })
        // Retain last 30 events for replay
        if (history.length > 30) {
            history.splice(0, history.length - 30)
        }

        // Persist atomically in Durable Object storage
        await this.ctx.storage.put({
            latest_event: event,
            latest_seq: seq,
            event_history: history,
        })

        // Broadcast to all active clients
        const payload = `id: ${seq}\nevent: ${event.status === "ready" ? "ready" : event.status === "failed" ? "failed" : "progress"}\ndata: ${JSON.stringify(event)}\n\n`
        const bytes = this.encoder.encode(payload)

        for (const writer of Array.from(this.connectedClients)) {
            writer.write(bytes).catch(() => {
                this.removeClient(writer)
            })
        }
    }

    /**
     * HTTP handler for client SSE streams and internal event fallbacks
     */
    async fetch(request: Request): Promise<Response> {
        const requestUrl =
            typeof request === "string" ? request : request?.url || "https://internal/progress"
        const url = new URL(requestUrl, "https://internal")
        const method = (typeof request === "string" ? "GET" : request?.method) || "GET"

        // Internal HTTP event reporting fallback
        if (method === "POST" && url.pathname.endsWith("/event")) {
            try {
                const event = (await request.json()) as DocumentProgressEvent
                await this.reportProgress(event)
                return Response.json({ success: true, seq: this.currentSeq })
            } catch (err) {
                const msg = err instanceof Error ? err.message : "Failed to parse event"
                return Response.json({ error: msg }, { status: 400 })
            }
        }

        await this.ensureInitialized()

        // Establish SSE stream
        const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
        const writer = writable.getWriter()

        // Handle client abort / disconnect signal
        if (request?.signal?.aborted) {
            this.removeClient(writer)
            return new Response(readable, {
                status: 200,
                headers: SSE_HEADERS,
            })
        }
        request?.signal?.addEventListener("abort", () => {
            this.removeClient(writer)
        })

        // Handle Last-Event-ID recovery or send current state
        const lastEventIdHeader =
            typeof request?.headers?.get === "function"
                ? request.headers.get("Last-Event-ID")
                : null
        const lastSeq = lastEventIdHeader ? parseInt(lastEventIdHeader, 10) : NaN

        // CRITICAL FIX: Replay historical events or send latest snapshot BEFORE
        // adding the writer to this.connectedClients to eliminate inverted event delivery race.
        try {
            const history: StoredEventRecord[] =
                (await this.ctx.storage.get<StoredEventRecord[]>("event_history")) || []
            const latestEvent = await this.ctx.storage.get<DocumentProgressEvent>("latest_event")
            const latestSeq = (await this.ctx.storage.get<number>("latest_seq")) || 0

            if (!Number.isNaN(lastSeq) && lastSeq > 0) {
                // Replay missed events
                const missed = history.filter((h) => h.id > lastSeq)
                if (missed.length > 0) {
                    for (const item of missed) {
                        const eventName =
                            item.event.status === "ready"
                                ? "ready"
                                : item.event.status === "failed"
                                  ? "failed"
                                  : "progress"
                        const chunk = `id: ${item.id}\nevent: ${eventName}\ndata: ${JSON.stringify(item.event)}\n\n`
                        writer.write(this.encoder.encode(chunk)).catch(() => {})
                    }
                } else if (history.length > 0 && history[0].id > lastSeq && latestEvent) {
                    // History was truncated; send authoritative snapshot so client is not stuck
                    const eventName =
                        latestEvent.status === "ready"
                            ? "ready"
                            : latestEvent.status === "failed"
                              ? "failed"
                              : "progress"
                    const chunk = `id: ${latestSeq}\nevent: ${eventName}\ndata: ${JSON.stringify(latestEvent)}\n\n`
                    writer.write(this.encoder.encode(chunk)).catch(() => {})
                }
            } else if (latestEvent) {
                // Fresh connection: send current status snapshot
                const eventName =
                    latestEvent.status === "ready"
                        ? "ready"
                        : latestEvent.status === "failed"
                          ? "failed"
                          : "progress"
                const chunk = `id: ${latestSeq}\nevent: ${eventName}\ndata: ${JSON.stringify(latestEvent)}\n\n`
                writer.write(this.encoder.encode(chunk)).catch(() => {})
            }
        } catch {
            this.removeClient(writer)
            return new Response(readable, {
                status: 200,
                headers: SSE_HEADERS,
            })
        }

        // Register writer for subsequent live broadcasts only AFTER replay has completed
        this.connectedClients.add(writer)
        this.startHeartbeatIfNeeded()

        return new Response(readable, {
            status: 200,
            headers: SSE_HEADERS,
        })
    }
}
