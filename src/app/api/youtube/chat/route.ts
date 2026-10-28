import { env } from "cloudflare:workers"
import { z } from "zod"
import { streamChat } from "@/lib/ai"
import { verifyPin } from "@/lib/auth"
import {
    createConversation,
    createMessage,
    getConversation,
    getMessages,
    getYoutubeVideo,
} from "@/lib/db"
import { createSSEStream, SSE_HEADERS } from "@/lib/sse"
import type { AppEnv, Citation } from "@/lib/types"
import { formatTimestamp } from "@/lib/youtube-chunker"
import { YOUTUBE_CHAT_CONFIG } from "@/lib/youtube-model-config"
import { retrieveYoutubeContext } from "@/lib/youtube-rag"

const YoutubeChatSchema = z.object({
    conversationId: z.string().optional(),
    videoId: z.string().min(5).max(30),
    message: z
        .string()
        .min(1, "Message cannot be empty")
        .max(10000, "Message exceeds 10,000 characters"),
    effort: z.enum(["low", "medium", "high"]).optional(),
})

export async function POST(req: Request) {
    try {
        const pin = req.headers.get("x-app-pin")
        if (!verifyPin(pin, req)) {
            return Response.json(
                { error: "Unauthorized. Please enter the correct 4-digit security PIN." },
                { status: 401 }
            )
        }

        const rawBody = await req.json().catch(() => ({}))
        const parsed = YoutubeChatSchema.safeParse(rawBody)

        if (!parsed.success) {
            return Response.json(
                { error: "Invalid request payload", details: parsed.error.format() },
                { status: 400 }
            )
        }

        const { videoId, message, effort = YOUTUBE_CHAT_CONFIG.defaultEffort } = parsed.data
        const appEnv = env as unknown as AppEnv
        const ai = appEnv.AI
        const vectorize = appEnv.VECTORIZE
        const r2 = appEnv.FILES
        const db = appEnv.DB

        // Verify that video exists in D1
        const video = await getYoutubeVideo(videoId, db)
        if (!video) {
            return Response.json({ error: "Referenced YouTube video not found" }, { status: 404 })
        }

        let conversationId = parsed.data.conversationId

        // Ensure independent conversation record in D1 tied to videoId
        if (!conversationId) {
            conversationId = crypto.randomUUID()
            const generatedTitle =
                message.length > 40 ? `${message.slice(0, 37).trim()}...` : message.trim()
            await createConversation(
                conversationId,
                generatedTitle || `${video.title} Chat`,
                YOUTUBE_CHAT_CONFIG.modelId,
                "youtube",
                videoId,
                db
            )
        } else {
            const existing = await getConversation(conversationId, db)
            if (!existing) {
                const generatedTitle =
                    message.length > 40 ? `${message.slice(0, 37).trim()}...` : message.trim()
                await createConversation(
                    conversationId,
                    generatedTitle || `${video.title} Chat`,
                    YOUTUBE_CHAT_CONFIG.modelId,
                    "youtube",
                    videoId,
                    db
                )
            } else if (existing.type !== "youtube" && existing.type !== undefined) {
                return Response.json(
                    { error: "Incompatible conversation type. Cannot mix PDF and YouTube chats." },
                    { status: 400 }
                )
            }
        }

        // Save user message to D1
        const userMessageId = crypto.randomUUID()
        const userCreatedAt = Date.now()
        await createMessage(
            {
                id: userMessageId,
                conversation_id: conversationId,
                role: "user",
                content: message,
                model: YOUTUBE_CHAT_CONFIG.modelId,
                effort,
                created_at: userCreatedAt,
            },
            db
        )

        // Retrieve scoped transcript chunks for this specific video
        const retrievedChunks = await retrieveYoutubeContext(
            ai,
            vectorize,
            r2,
            db,
            videoId,
            message,
            YOUTUBE_CHAT_CONFIG.retrievalTopK
        )

        // Map and validate structured citations strictly from retrieved segments
        const validatedCitations: Citation[] = retrievedChunks.map((chunk) => ({
            id: chunk.id,
            videoId,
            startSeconds: chunk.startSeconds,
            endSeconds: chunk.endSeconds,
            text: chunk.text.slice(0, 200),
        }))

        // Build grounded system prompt
        let systemPrompt = ""
        if (retrievedChunks.length > 0) {
            const contextText = retrievedChunks
                .map(
                    (c, i) =>
                        `[Transcript Segment ${i + 1} | Time: ${formatTimestamp(c.startSeconds)} - ${formatTimestamp(c.endSeconds)}]\n${c.text}`
                )
                .join("\n\n")

            systemPrompt = `You are an expert AI video assistant analyzing the YouTube video "${video.title}".
You have access to exact, timestamped transcript segments from this video.

--- RETRIEVED TRANSCRIPT EXCERPTS ---
${contextText}
--- END TRANSCRIPT EXCERPTS ---

INSTRUCTIONS:
1. Ground your answers strictly in the transcript excerpts above.
2. When referencing facts, topics, or statements from the video, cite the timestamp using markdown format [MM:SS] (for example: [02:15] or [01:30 - 02:00]) where the topic is discussed.
3. Only cite timestamps that appear in the transcript excerpts above. Never invent timestamps.
4. If the transcript does not contain enough information to answer the question, state honestly that the video transcript does not discuss that topic.
5. If the user greeting is simple (e.g. "hi", "hello"), greet them warmly and let them know you're ready to answer questions about "${video.title}".`
        } else {
            systemPrompt = `You are an AI video assistant for the YouTube video "${video.title}". Currently no transcript segments were matched for this query. If the user asks general questions, answer helpfully; if they ask about specific details from the video, let them know that the transcript content is still indexing or does not cover that query.`
        }

        // Fetch recent message history for this conversation
        const history = await getMessages(conversationId, 10, db)
        const chatMessages: Array<{ role: string; content: string }> = []
        for (const m of history) {
            if (m.id === userMessageId) continue
            chatMessages.push({ role: m.role, content: m.content })
        }

        // Append augmented prompt
        chatMessages.push({
            role: "user",
            content: message,
        })

        // Create SSE stream
        const { readable, send, close } = createSSEStream()
        const assistantMessageId = crypto.randomUUID()

        // Asynchronous streaming worker
        ;(async () => {
            let fullContent = ""
            let fullReasoning = ""

            try {
                // Send initial conversation metadata and validated citations immediately
                await send({
                    conversationId,
                })

                if (validatedCitations.length > 0) {
                    await send(
                        JSON.stringify({
                            type: "citations",
                            citations: validatedCitations,
                        })
                    )
                }

                const generator = streamChat(YOUTUBE_CHAT_CONFIG.modelId, chatMessages, {
                    effort,
                    systemPrompt,
                    aiOverride: ai,
                })

                for await (const chunk of generator) {
                    if (chunk.isDone) break
                    if (chunk.reasoning) {
                        fullReasoning += chunk.reasoning
                        await send({ reasoning: chunk.reasoning })
                    }
                    if (chunk.delta) {
                        fullContent += chunk.delta
                        await send({ delta: chunk.delta })
                    }
                }

                // Append citation badge if user asked about video facts and no timestamp was cited
                if (validatedCitations.length > 0) {
                    const hasTimestampMention = /\[\d{1,2}:\d{2}\]|\b\d{1,2}:\d{2}\b/.test(
                        fullContent
                    )
                    if (!hasTimestampMention) {
                        const topCitation = validatedCitations[0]
                        const badge = `\n\n[${formatTimestamp(topCitation.startSeconds)}]`
                        fullContent += badge
                        await send({ delta: badge })
                    }
                }

                // Persist completed message in D1 with citations
                const assistantCreatedAt = Date.now()
                await createMessage(
                    {
                        id: assistantMessageId,
                        conversation_id: conversationId,
                        role: "assistant",
                        content: fullContent,
                        model: YOUTUBE_CHAT_CONFIG.modelId,
                        effort,
                        reasoning: fullReasoning || null,
                        citations: validatedCitations,
                        created_at: assistantCreatedAt,
                    },
                    db
                )

                // Notify completion
                await send({
                    done: true,
                    messageId: assistantMessageId,
                    conversationId,
                    createdAt: assistantCreatedAt,
                })
                await send("[DONE]")
            } catch (streamErr: unknown) {
                console.error("[YouTube Chat Stream Error]:", streamErr)
                const errMsg =
                    streamErr instanceof Error ? streamErr.message : "Inference streaming error"
                await send({ error: errMsg })
            } finally {
                await close()
            }
        })()

        return new Response(readable, {
            headers: SSE_HEADERS,
        })
    } catch (error: unknown) {
        console.error("Error in POST /api/youtube/chat:", error)
        const msg =
            error instanceof Error ? error.message : "Failed to process YouTube chat request"
        return Response.json({ error: msg }, { status: 500 })
    }
}
