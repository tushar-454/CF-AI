import { acceptModelAgreement, getR2, streamChat } from "@/lib/ai"
import { verifyPin } from "@/lib/auth"
import {
    createConversation,
    createMessage,
    getConversation,
    getDocument,
    getMessages,
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
    selectedDocumentIds: z.array(z.string()).optional(),
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
    createdAt: z.number().optional(),
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
            selectedDocumentIds = [],
            createdAt,
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
        const userCreatedAt = createdAt || Date.now()
        await createMessage({
            id: userMessageId,
            conversation_id: conversationId,
            role: "user",
            content: message,
            model,
            effort,
            attachments,
            created_at: userCreatedAt,
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

        // Handle Knowledge base RAG context:
        // STRICT RULE: Only query Vectorize and inject knowledge base context if the user has
        // explicitly checked/selected specific document(s) for this chat conversation.
        // If no documents are selected (the default), DO NOT inject any vector or knowledge context.
        let ragSystemPrompt = ""
        const hasSelectedDocs =
            contextMode !== "none" &&
            Array.isArray(selectedDocumentIds) &&
            selectedDocumentIds.length > 0

        if (hasSelectedDocs) {
            try {
                const appEnv = env as unknown as AppEnv
                const ai = appEnv.AI
                const vectorize = appEnv.VECTORIZE
                let contextChunks: Array<{ documentId: string; name: string; text: string }> = []

                if (ai && vectorize) {
                    const rawChunks = await queryKnowledge(ai, vectorize, message, 15)
                    // Strict filtering: ONLY retain chunks that belong to the user's selected documents
                    const matchingChunks = rawChunks.filter(
                        (c) => c.documentId && selectedDocumentIds.includes(c.documentId)
                    )

                    matchingChunks.sort((a, b) => b.score - a.score)

                    contextChunks = matchingChunks.slice(0, 6).map((c) => ({
                        documentId: c.documentId,
                        name: c.name,
                        text: c.text,
                    }))
                }

                // If any of the user's selected documents did not have vector chunks returned
                // (e.g. meta-question like "give me text that pdf have", or small doc),
                // fetch directly from R2/D1 ONLY for those selected documents!
                const missingDocIds = selectedDocumentIds.filter(
                    (id) => !contextChunks.some((c) => c.documentId === id)
                )

                if (missingDocIds.length > 0) {
                    try {
                        const r2 = getR2()
                        for (const docId of missingDocIds) {
                            try {
                                const doc = await getDocument(docId).catch(() => null)
                                if (!doc) continue
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
                                            documentId: doc.id,
                                            name: doc.name,
                                            text: text.slice(0, 8000),
                                        })
                                        // Index into Vectorize in the background so future queries have vectors
                                        if (ai && vectorize) {
                                            indexDocument(
                                                ai,
                                                vectorize,
                                                doc.id,
                                                doc.name,
                                                text,
                                                null
                                            ).catch((e) =>
                                                console.warn("Background index failed:", e)
                                            )
                                        }
                                    }
                                }
                            } catch (docErr) {
                                console.warn(`Could not read selected doc ${docId}:`, docErr)
                            }
                        }
                    } catch (r2Err) {
                        console.warn("Could not fetch selected documents from storage:", r2Err)
                    }
                }

                if (contextChunks.length > 0) {
                    const contextText = contextChunks
                        .map((c, i) => `[Selected Document ${i + 1}: ${c.name}]\n${c.text}`)
                        .join("\n\n")
                    ragSystemPrompt = `You are a helpful, intelligent AI chat assistant. You have access to reference materials from the user's explicitly selected knowledge base document(s):

--- SELECTED KNOWLEDGE BASE REFERENCE MATERIALS ---
${contextText}
--- END OF REFERENCE MATERIALS ---

CORE INSTRUCTIONS & PRIORITY HIERARCHY:
1. AI CHAT ASSISTANT BEHAVIOR:
   - Act as a friendly, natural, and helpful AI chat assistant at all times.
   - For simple greetings (such as "hi", "hello", "hey"), pleasantries, or casual small talk, respond warmly, naturally, and concisely (e.g. "Hello! How can I help you today?").
   - DO NOT overthink or refuse greetings, and do not say "I can only answer from the document".
   - If the user asks general everyday questions unrelated to the selected documents, answer helpfully using your general knowledge.

2. HIGHEST PRIORITY FOR KNOWLEDGE BASE (CRUCIAL & STRICT):
   - Whenever the user's question, prompt, or discussion context matches, inquires about, or relates to the selected knowledge base document(s) (including topics, details, facts, numbers, policies, procedures, summaries, or questions about what the document contains):
     * The selected knowledge base reference materials MUST BE GIVEN TOP PRIORITY over everything else.
     * This knowledge base is CRUCIAL and MUST BE STRICTLY FOLLOWED.
     * Ground your answers directly, accurately, and faithfully in the reference materials provided above.
     * Do not contradict or override the document details with external assumptions.
     * If the user requests the summary, full text, or specific details from a selected document, provide them accurately and thoroughly from these reference materials.`
                } else {
                    ragSystemPrompt = `You are a helpful, intelligent AI chat assistant. The user has selected knowledge base documents for this chat.
- Act as a normal, natural, and helpful AI chat assistant.
- For simple greetings (such as "hi", "hello"), respond warmly and concisely without overthinking.
- If the user asks about the selected documents, acknowledge them and provide whatever assistance you can.`
                }
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err)
                console.warn("RAG query failed or Vectorize not configured:", msg)
            }
        } else {
            // No knowledge base document selected: Act purely as a normal AI chat box with Cloudflare AI model
            ragSystemPrompt = `You are a helpful, versatile, and conversational AI chat assistant powered by Cloudflare Workers AI.

CHAT GUIDELINES:
- This is a conversational AI chat box. Respond naturally, warmly, and helpfully.
- For simple greetings (such as "hi", "hello", "hey"), pleasantries, or casual small talk, respond concisely, warmly, and directly (e.g. "Hello! How can I help you today?").
- DO NOT overthink or output unnecessary, lengthy, unsolicited lectures, essays, or repetitive filler for simple greetings or casual queries.
- When the user asks specific, analytical, coding, or complex questions, provide clear, accurate, and well-structured answers tailored directly to what they requested.`
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
                const assistantCreatedAt = Date.now()
                await createMessage({
                    id: assistantMessageId,
                    conversation_id: conversationId,
                    role: "assistant",
                    content: fullAssistantContent,
                    model,
                    effort,
                    reasoning: fullAssistantReasoning || null,
                    created_at: assistantCreatedAt,
                })

                // Notify client completion
                await send({
                    done: true,
                    messageId: assistantMessageId,
                    conversationId,
                    createdAt: assistantCreatedAt,
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
