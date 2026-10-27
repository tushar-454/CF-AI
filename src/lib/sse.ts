export interface SSEEvent {
    delta?: string
    reasoning?: string
    error?: string
    done?: boolean
    messageId?: string
    conversationId?: string
    createdAt?: number
}

export function formatSSE(data: SSEEvent | string): string {
    if (typeof data === "string") {
        return `data: ${data}\n\n`
    }
    return `data: ${JSON.stringify(data)}\n\n`
}

export function createSSEStream() {
    const encoder = new TextEncoder()
    const { readable, writable } = new TransformStream()
    const writer = writable.getWriter()

    const send = async (event: SSEEvent | string) => {
        try {
            await writer.write(encoder.encode(formatSSE(event)))
        } catch {
            // Stream may have closed or aborted
        }
    }

    const close = async () => {
        try {
            await writer.close()
        } catch {
            // Ignored if already closed
        }
    }

    return {
        readable,
        send,
        close,
    }
}

export const SSE_HEADERS = {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
}
