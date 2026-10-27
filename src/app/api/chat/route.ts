import { z } from "zod"
import { createConversation, createMessage, getConversation, getMessages } from "@/lib/db"
import { acceptModelAgreement, streamChat } from "@/lib/ai"
import { createSSEStream, SSE_HEADERS } from "@/lib/sse"
import { queryKnowledge } from "@/lib/rag"
import { DEFAULT_MODEL_ID } from "@/lib/models"
import { env } from "cloudflare:workers"
import { verifyPin } from "@/lib/auth"

const ChatRequestSchema = z.object({
    conversationId: z.string().optional(),
    message: z
        .string()
        .min(1, "Message cannot be empty")
        .max(10000, "Message exceeds 10,000 characters"),
    model: z.string().optional(),
    effort: z.enum(["low", "medium", "high"]).optional(),
    contextMode: z.enum(["none", "conversation", "knowledge", "files"]).optional(),
    attachments: z
        .array(
            z.object({
                id: z.string(),
                name: z.string(),
                mime: z.string(),
                size: z.number(),
                r2_key: z.string(),
                isImage: z.boolean(),
                textContent: z.string().optional(),
            })
        )
        .optional(),
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

        const rawBody = await req.json()
        const parsed = ChatRequestSchema.safeParse(rawBody)

        if (!parsed.success) {
            return Response.json(
                { error: "Invalid request payload", details: parsed.error.format() },
                { status: 400 }
            )
        }

        const {
            message,
            model = DEFAULT_MODEL_ID,
            effort = "medium",
            contextMode = "conversation",
            attachments = [],
        } = parsed.data

        let conversationId = parsed.data.conversationId

        // Check or create conversation in D1
        if (!conversationId) {
            conversationId = crypto.randomUUID()
            // Auto-title from the first ~40 characters of the prompt
            const generatedTitle =
                message.length > 40 ? `${message.slice(0, 37).trim()}...` : message.trim()
            await createConversation(conversationId, generatedTitle || "New Conversation", model)
        } else {
            const existing = await getConversation(conversationId)
            if (!existing) {
                const generatedTitle =
                    message.length > 40 ? `${message.slice(0, 37).trim()}...` : message.trim()
                await createConversation(
                    conversationId,
                    generatedTitle || "New Conversation",
                    model
                )
            }
        }

        // Save user message to D1
        const userMessageId = crypto.randomUUID()
        await createMessage({
            id: userMessageId,
            conversation_id: conversationId,
            role: "user",
            content: message,
            model,
            effort,
            attachments,
        })

        // Prepare message history based on contextMode
        const chatMessages: Array<{ role: string; content: string }> = []

        if (contextMode !== "none") {
            const history = await getMessages(conversationId, 15)
            for (const m of history) {
                if (m.id === userMessageId) continue // Will be added at the end
                chatMessages.push({
                    role: m.role,
                    content: m.content,
                })
            }
        }

        // Add current user message
        let finalUserContent = message
        if (contextMode === "files" && attachments.length > 0) {
            const fileContexts = attachments
                .filter((a) => a.textContent)
                .map((a) => `[File: ${a.name}]\n${a.textContent}`)
                .join("\n\n")
            if (fileContexts) {
                finalUserContent += `\n\n--- Attached Files Content ---\n${fileContexts}`
            }
        }

        chatMessages.push({
            role: "user",
            content: finalUserContent,
        })

        // Handle Knowledge base RAG context
        let ragSystemPrompt = ""
        if (contextMode === "knowledge") {
            try {
                const ai = (env as any)?.AI
                const vectorize = (env as any)?.VECTORIZE
                if (ai && vectorize) {
                    const chunks = await queryKnowledge(ai, vectorize, message, 5)
                    if (chunks.length > 0) {
                        const contextText = chunks
                            .map((c, i) => `[Document ${i + 1}: ${c.name}]\n${c.text}`)
                            .join("\n\n")
                        ragSystemPrompt = `You have access to the following relevant reference materials from the knowledge base:\n\n${contextText}\n\nUse this information to answer the user accurately and cite the source document name when appropriate.`
                    }
                }
            } catch (err: any) {
                console.warn("RAG query failed or Vectorize not configured:", err?.message)
            }
        }

        // Create SSE response stream
        const { readable, send, close } = createSSEStream()
        const assistantMessageId = crypto.randomUUID()

        // Stream in the background
        ;(async () => {
            let fullAssistantContent = ""
            let fullAssistantReasoning = ""

            try {
                // Send initial conversationId so client can immediately link the chat in the URL
                await send({
                    conversationId,
                })

                const generator = streamChat(model, chatMessages, {
                    effort,
                    attachments,
                    systemPrompt: ragSystemPrompt,
                })

                for await (const chunk of generator) {
                    if (chunk.isDone) {
                        break
                    }
                    if (chunk.reasoning) {
                        fullAssistantReasoning += chunk.reasoning
                        await send({ reasoning: chunk.reasoning })
                    }
                    if (chunk.delta) {
                        fullAssistantContent += chunk.delta
                        await send({ delta: chunk.delta })
                    }
                }

                // Save complete assistant message to D1
                await createMessage({
                    id: assistantMessageId,
                    conversation_id: conversationId,
                    role: "assistant",
                    content: fullAssistantContent,
                    model,
                    effort,
                    reasoning: fullAssistantReasoning || null,
                })

                // Notify client completion
                await send({
                    done: true,
                    messageId: assistantMessageId,
                    conversationId,
                })
                await send("[DONE]")
            } catch (streamError: any) {
                console.error("Stream error in /api/chat:", streamError)
                const errMsg = streamError?.message || "An error occurred during inference"
                if (
                    errMsg.includes("5016") ||
                    errMsg.includes("submit the prompt 'agree'") ||
                    errMsg.includes("Community License")
                ) {
                    try {
                        await acceptModelAgreement(model)
                    } catch {}
                }
                await send({
                    error: errMsg,
                })
            } finally {
                await close()
            }
        })()

        return new Response(readable, {
            headers: SSE_HEADERS,
        })
    } catch (error: any) {
        console.error("Error in /api/chat:", error)
        const isBindingError =
            error?.name === "DatabaseBindingError" ||
            error?.name === "AiBindingError" ||
            error?.message?.includes("REPLACE_WITH_")

        return Response.json(
            {
                error: error?.message || "Failed to process chat request",
                isBindingError: Boolean(isBindingError),
            },
            { status: isBindingError ? 503 : 500 }
        )
    }
}
