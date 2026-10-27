import { acceptModelAgreement, getR2, streamChat } from "@/lib/ai"
import { verifyPin } from "@/lib/auth"
import {
    createConversation,
    createMessage,
    getConversation,
    getMessages,
    listDocuments,
} from "@/lib/db"
import { DEFAULT_MODEL_ID } from "@/lib/models"
import { indexDocument, queryKnowledge } from "@/lib/rag"
import { isPdfFile, extractPdfText } from "@/lib/pdf"
import { createSSEStream, SSE_HEADERS } from "@/lib/sse"
import { AppEnv } from "@/lib/types"
import { env } from "cloudflare:workers"
import { z } from "zod"

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
                isPdf: z.boolean().optional(),
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
        // If files are attached to the message, inject their text whenever contextMode !== "none"
        if (contextMode !== "none" && attachments.length > 0) {
            const fileContexts = attachments
                .filter((a) => a.textContent && a.textContent.trim())
                .map((a) => `[Attached File: ${a.name}]\n${a.textContent}`)
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
        if (contextMode === "knowledge" || contextMode === "conversation") {
            try {
                const appEnv = env as unknown as AppEnv
                const ai = appEnv.AI
                const vectorize = appEnv.VECTORIZE
                let contextChunks: Array<{ name: string; text: string }> = []

                if (ai && vectorize) {
                    const rawChunks = await queryKnowledge(ai, vectorize, message, 8)
                    // Prioritize chat-specific knowledge, then global knowledge, exclude other chats
                    const filteredChunks = rawChunks.filter(
                        (c) => !c.conversationId || c.conversationId === conversationId
                    )

                    // In conversation mode, accept chunks if they belong to this chat, or have solid score
                    const relevantChunks =
                        contextMode === "knowledge"
                            ? filteredChunks
                            : filteredChunks.filter(
                                  (c) => c.conversationId === conversationId || c.score >= 0.55
                              )

                    // Sort: conversation-specific chunks first, then by score
                    relevantChunks.sort((a, b) => {
                        const aIsChat = a.conversationId === conversationId ? 1 : 0
                        const bIsChat = b.conversationId === conversationId ? 1 : 0
                        if (aIsChat !== bIsChat) return bIsChat - aIsChat
                        return b.score - a.score
                    })

                    contextChunks = relevantChunks.slice(0, 5).map((c) => ({
                        name: c.name,
                        text: c.text,
                    }))
                }

                // Auto-recovery / Fallback: If this conversation has documents in D1,
                // but no chunks were matched yet (e.g. uploaded before indexing was fixed, or query is generic like "give me text that pdf have")
                if (conversationId && contextChunks.length === 0) {
                    try {
                        const chatDocs = await listDocuments(conversationId)
                        if (chatDocs.length > 0) {
                            const r2 = getR2()
                            for (const doc of chatDocs.slice(0, 3)) {
                                try {
                                    const obj = await r2.get(doc.r2_key)
                                    if (obj) {
                                        const buf = await obj.arrayBuffer()
                                        let text = ""
                                        if (isPdfFile(doc.mime, doc.name)) {
                                            text = await extractPdfText(buf, ai)
                                        } else {
                                            text = new TextDecoder().decode(buf)
                                        }
                                        if (text.trim()) {
                                            contextChunks.push({
                                                name: doc.name,
                                                text: text.slice(0, 8000),
                                            })
                                            // Index into Vectorize in the background so subsequent queries hit the vector cache
                                            if (ai && vectorize) {
                                                indexDocument(
                                                    ai,
                                                    vectorize,
                                                    doc.id,
                                                    doc.name,
                                                    text,
                                                    conversationId
                                                ).catch((e) =>
                                                    console.warn("Background index failed:", e)
                                                )
                                            }
                                        }
                                    }
                                } catch (docErr) {
                                    console.warn(`Could not read doc ${doc.name}:`, docErr)
                                }
                            }
                        }
                    } catch (d1Err) {
                        console.warn("Could not check conversation documents:", d1Err)
                    }
                }

                if (contextChunks.length > 0) {
                    const contextText = contextChunks
                        .map((c, i) => `[Document ${i + 1}: ${c.name}]\n${c.text}`)
                        .join("\n\n")
                    ragSystemPrompt = `You have access to the following relevant reference materials from the knowledge base:\n\n${contextText}\n\nUse this information to answer the user accurately and cite the source document name when appropriate.`
                }
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err)
                console.warn("RAG query failed or Vectorize not configured:", msg)
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
            } catch (streamError: unknown) {
                console.error("Stream error in /api/chat:", streamError)
                const errMsg =
                    streamError instanceof Error
                        ? streamError.message
                        : "An error occurred during inference"
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
    } catch (error: unknown) {
        console.error("Error in /api/chat:", error)
        const isBindingError =
            error instanceof Error &&
            (error.name === "DatabaseBindingError" ||
                error.name === "AiBindingError" ||
                error.message.includes("REPLACE_WITH_"))
        const errorMessage =
            error instanceof Error ? error.message : "Failed to process chat request"

        return Response.json(
            {
                error: errorMessage,
                isBindingError: Boolean(isBindingError),
            },
            { status: isBindingError ? 503 : 500 }
        )
    }
}
