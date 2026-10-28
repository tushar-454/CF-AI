import { getAuthHeaders } from "./auth-client"
import { DocumentProgressEvent } from "./types"

export interface DocumentProgressSubscriber {
    onProgress?: (event: DocumentProgressEvent) => void
    onReady?: (event: DocumentProgressEvent) => void
    onFailed?: (event: DocumentProgressEvent) => void
    onError?: (err: Error) => void
}

/**
 * Connect to the Durable Object SSE stream for real-time document processing updates.
 * Supports auto-reconnect with Last-Event-ID recovery, deduplication, and stream cleanup.
 */
export function subscribeToDocumentProgress(
    documentId: string,
    callbacks: DocumentProgressSubscriber
): () => void {
    let aborted = false
    let controller: AbortController | null = null
    let reconnectTimeout: ReturnType<typeof setTimeout> | null = null
    let lastEventId: number | null = null
    let reconnectAttempts = 0
    const maxReconnectAttempts = 5

    async function connect() {
        if (aborted) return

        controller = new AbortController()
        const headers = getAuthHeaders()
        if (lastEventId !== null) {
            headers["Last-Event-ID"] = String(lastEventId)
        }

        try {
            const res = await fetch(`/api/files/${documentId}/progress`, {
                method: "GET",
                headers,
                signal: controller.signal,
            })

            if (!res.ok) {
                if (res.status === 404) {
                    throw new Error("Document not found.")
                }
                const errJson = (await res.json().catch(() => ({}))) as { error?: string }
                throw new Error(errJson.error || `HTTP ${res.status}`)
            }

            if (!res.body) {
                throw new Error("No response body received from SSE stream.")
            }

            reconnectAttempts = 0 // Reset on successful connection
            const reader = res.body.getReader()
            const decoder = new TextDecoder()
            let buffer = ""

            while (!aborted) {
                const { done, value } = await reader.read()
                if (done) break

                buffer += decoder.decode(value, { stream: true })
                const parts = buffer.split("\n\n")
                buffer = parts.pop() || ""

                for (const part of parts) {
                    const lines = part.split("\n")
                    let eventName = "progress"
                    let dataStr = ""

                    for (const line of lines) {
                        const trimmed = line.trim()
                        if (!trimmed || trimmed.startsWith(":")) {
                            // SSE comment / heartbeat (e.g. : ping)
                            continue
                        }
                        if (trimmed.startsWith("id:")) {
                            const parsedId = parseInt(trimmed.slice(3).trim(), 10)
                            if (!Number.isNaN(parsedId)) {
                                lastEventId = parsedId
                            }
                        } else if (trimmed.startsWith("event:")) {
                            eventName = trimmed.slice(6).trim()
                        } else if (trimmed.startsWith("data:")) {
                            dataStr += (dataStr ? "\n" : "") + trimmed.slice(5).trim()
                        }
                    }

                    if (!dataStr) continue

                    try {
                        const event = JSON.parse(dataStr) as DocumentProgressEvent
                        if (eventName === "ready" || event.status === "ready") {
                            callbacks.onReady?.(event)
                            aborted = true
                            return
                        } else if (eventName === "failed" || event.status === "failed") {
                            callbacks.onFailed?.(event)
                            aborted = true
                            return
                        } else {
                            callbacks.onProgress?.(event)
                        }
                    } catch {
                        // Ignore malformed JSON event chunk
                    }
                }
            }
        } catch (err: unknown) {
            if (aborted) return
            const isAbort = err instanceof Error && err.name === "AbortError"
            if (!isAbort) {
                callbacks.onError?.(err instanceof Error ? err : new Error(String(err)))
            }
        }

        // Reconnect if not aborted and haven't exceeded retry limit
        if (!aborted && reconnectAttempts < maxReconnectAttempts) {
            reconnectAttempts++
            const delay = Math.min(1000 * Math.pow(1.5, reconnectAttempts), 5000)
            reconnectTimeout = setTimeout(connect, delay)
        }
    }

    void connect()

    return () => {
        aborted = true
        if (controller) {
            controller.abort()
            controller = null
        }
        if (reconnectTimeout) {
            clearTimeout(reconnectTimeout)
            reconnectTimeout = null
        }
    }
}
