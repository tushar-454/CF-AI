/**
 * Client-side utilities and SSE progress subscription for YouTube video processing.
 */

import { getAuthHeaders } from "./auth-client"
import type {
    TranscriptSegment,
    YoutubeConfirmationRequest,
    YoutubeInitRequest,
    YoutubeInitResponse,
    YoutubeProgressEvent,
    YoutubeVideoItem,
} from "./types"

export interface VideoProgressSubscriber {
    onProgress?: (event: YoutubeProgressEvent) => void
    onReady?: (event: YoutubeProgressEvent) => void
    onFailed?: (event: YoutubeProgressEvent) => void
    onAwaitingConfirmation?: (event: YoutubeProgressEvent) => void
    onError?: (err: Error) => void
}

/**
 * Connects to the SSE progress stream for real-time video processing updates.
 * Supports auto-reconnect, Last-Event-ID recovery, and stream cleanup.
 */
export function subscribeToVideoProgress(
    videoId: string,
    callbacks: VideoProgressSubscriber
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
            const res = await fetch(`/api/youtube/${encodeURIComponent(videoId)}/progress`, {
                method: "GET",
                headers,
                signal: controller.signal,
            })

            if (!res.ok) {
                if (res.status === 404) {
                    throw new Error("Video record not found.")
                }
                const errJson = (await res.json().catch(() => ({}))) as { error?: string }
                throw new Error(errJson.error || `HTTP ${res.status}`)
            }

            if (!res.body) {
                throw new Error("No response body received from SSE stream.")
            }

            reconnectAttempts = 0
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
                            continue // Heartbeat or comment
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
                        const event = JSON.parse(dataStr) as YoutubeProgressEvent
                        if (event.diagnostic) {
                            console.warn(
                                `[youtube-transcript] Primary provider failed; fallback started`,
                                {
                                    requestId: event.diagnostic.requestId,
                                    provider: event.diagnostic.provider,
                                    failureCategory: event.diagnostic.failureCategory,
                                    message: event.diagnostic.message,
                                }
                            )
                        }
                        if (eventName === "ready" || event.status === "ready") {
                            callbacks.onReady?.(event)
                            aborted = true
                            return
                        } else if (eventName === "failed" || event.status === "failed") {
                            callbacks.onFailed?.(event)
                            aborted = true
                            return
                        } else if (
                            eventName === "awaiting_confirmation" ||
                            event.status === "awaiting_confirmation" ||
                            event.needsConfirmation
                        ) {
                            callbacks.onAwaitingConfirmation?.(event)
                        } else {
                            callbacks.onProgress?.(event)
                        }
                    } catch {
                        // Ignore malformed chunks
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

/**
 * Initializes YouTube video processing.
 */
export async function initYouTubeVideo(url: string, title?: string): Promise<YoutubeInitResponse> {
    const payload: YoutubeInitRequest = { url }
    const res = await fetch("/api/youtube/init", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            ...getAuthHeaders(),
        },
        body: JSON.stringify({ ...payload, title }),
    })

    const data = (await res.json()) as { error?: string } & YoutubeInitResponse
    if (!res.ok) {
        throw new Error(data.error || "Failed to initialize YouTube video")
    }

    return data
}

/**
 * Confirms or declines AI transcription for a video in awaiting_confirmation state.
 */
export async function confirmYouTubeTranscription(
    videoId: string,
    confirmed: boolean
): Promise<{ success: boolean; status: string; message?: string }> {
    const payload: YoutubeConfirmationRequest = { videoId, confirmed }
    const res = await fetch("/api/youtube/confirm-transcription", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            ...getAuthHeaders(),
        },
        body: JSON.stringify(payload),
    })

    const data = (await res.json()) as {
        success: boolean
        status: string
        message?: string
        error?: string
    }
    if (!res.ok) {
        throw new Error(data.error || "Failed to confirm AI transcription")
    }

    return data
}

/**
 * Fetches video metadata and transcript segments.
 */
export async function fetchYouTubeVideoDetails(
    videoId: string
): Promise<{ video: YoutubeVideoItem; segments: TranscriptSegment[] }> {
    const res = await fetch(`/api/youtube/${encodeURIComponent(videoId)}`, {
        method: "GET",
        headers: getAuthHeaders(),
    })

    const data = (await res.json()) as {
        video: YoutubeVideoItem
        segments: TranscriptSegment[]
        error?: string
    }
    if (!res.ok) {
        throw new Error(data.error || "Failed to load YouTube video details")
    }

    return data
}
