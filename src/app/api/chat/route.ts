import { acceptModelAgreement, streamChat } from "@/lib/ai"
import { verifyPin } from "@/lib/auth"
import {
    createConversation,
    createMessage,
    getConversation,
    getDocument,
    getMessages,
} from "@/lib/db"
import { DEFAULT_MODEL_ID } from "@/lib/models"
import { getDocumentR2Text, queryKnowledge, retrieveDocumentContext } from "@/lib/rag"
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

        const appEnv = env as unknown as AppEnv
        const ai = appEnv.AI
        const vectorize = appEnv.VECTORIZE
        const r2 = appEnv.FILES

        // If files are attached to the message, inject their text whenever contextMode !== "none"
        const attachedContexts: string[] = []
        if (contextMode !== "none" && attachments.length > 0) {
            for (const a of attachments) {
                let content = a.textContent?.trim() || ""
                if (!content && r2) {
                    try {
                        content = await getDocumentR2Text(r2, a.id, a.name, ai)
                    } catch {}
                }
                if (content) {
                    attachedContexts.push(`[Attached File: ${a.name}]\n${content.slice(0, 16000)}`)
                }
            }
        }

        // Handle Knowledge base RAG context:
        // When documents are selected (or contextMode === 'knowledge'), retrieve ground-truth chunks
        let ragSystemPrompt = ""
        let contextChunks: Array<{
            documentId: string
            name: string
            text: string
            pageNumber?: number
        }> = []
        const docNamesById: Record<string, string> = {}
        const pendingDocs: string[] = []

        const hasSelectedDocs =
            contextMode !== "none" &&
            Array.isArray(selectedDocumentIds) &&
            selectedDocumentIds.length > 0

        if (hasSelectedDocs) {
            // Fetch document metadata from D1
            for (const docId of selectedDocumentIds) {
                try {
                    const doc = await getDocument(docId)
                    if (doc) {
                        docNamesById[docId] = doc.name
                        if (doc.status === "queued" || doc.status === "processing") {
                            pendingDocs.push(doc.name)
                        }
                    }
                } catch {}
            }

            try {
                contextChunks = await retrieveDocumentContext(
                    ai,
                    vectorize,
                    r2,
                    message,
                    selectedDocumentIds,
                    docNamesById
                )
            } catch (ragErr) {
                console.warn("retrieveDocumentContext error:", ragErr)
            }
        } else if (contextMode === "knowledge" && ai && vectorize) {
            // General knowledge mode with no explicit document selected: query global Vectorize index
            try {
                const globalChunks = await queryKnowledge(ai, vectorize, message, 6)
                contextChunks = globalChunks.map((c) => ({
                    documentId: c.documentId,
                    name: c.name,
                    text: c.text,
                    pageNumber: c.pageNumber,
                }))
            } catch (vecErr) {
                console.warn("Global knowledge query failed:", vecErr)
            }
        }

        if (contextChunks.length > 0) {
            const docNamesList = Array.from(new Set(contextChunks.map((c) => c.name))).join(", ")
            const contextText = contextChunks
                .map(
                    (c, i) =>
                        `[Selected Document ${i + 1}: ${c.name}${c.pageNumber ? ` (Page ${c.pageNumber})` : ""}]\n${c.text}`
                )
                .join("\n\n")

            ragSystemPrompt = `You are a helpful, intelligent AI chat assistant. You have access to reference materials from the user's selected knowledge base document(s): ${docNamesList}

--- SELECTED KNOWLEDGE BASE REFERENCE MATERIALS ---
${contextText}
--- END OF REFERENCE MATERIALS ---

CORE INSTRUCTIONS & PRIORITY HIERARCHY:
1. HIGHEST PRIORITY FOR KNOWLEDGE BASE (CRUCIAL & STRICT):
   - Whenever the user's question, prompt, or discussion context inquires about, or relates to the selected document(s) (including topics, details, facts, numbers, policies, procedures, summaries, or questions about what the document contains):
     * The selected knowledge base reference materials MUST BE GIVEN TOP PRIORITY over everything else.
     * Ground your answers directly, accurately, thoroughly, and faithfully in the reference materials provided above.
     * If the user requests a summary, explanation, key takeaways, or specific details, provide them directly and accurately from these reference materials.
     * Do not claim you cannot view or access the document, because its contents are provided in the reference materials above.

2. MANDATORY PDF PAGE CITATION BADGE (CRUCIAL & REQUIRED):
   - Each excerpt in the reference materials specifies its originating page number.
   - When answering based on reference materials, you MUST conclude your response with a citation badge indicating the exact page number(s) where the facts were found.
   - Format: Place it at the very bottom of your response on its own clean line:
     📄 Page X (or 📄 Pages X, Y if multiple pages, e.g. 📄 Page 3 or 📄 Pages 2, 4)
   - Only cite actual page numbers present in the reference materials above.

3. CHAT ASSISTANT BEHAVIOR:
   - For simple greetings (such as "hi", "hello", "hey"), pleasantries, or casual small talk, respond warmly, naturally, and concisely (e.g. "Hello! I'm ready to help you with ${docNamesList}. What would you like to know?").
   - If the user asks general everyday questions unrelated to the selected documents, answer helpfully using your general knowledge.`
        } else if (pendingDocs.length > 0) {
            ragSystemPrompt = `You are a helpful AI assistant. Note: The user has selected documents that are currently still being processed and indexed in the background: ${pendingDocs.join(", ")}. If the user asks about content from those documents, let them know that indexing is completing in the background shortly.`
        } else {
            // No knowledge base document selected: Act purely as a normal AI chat box with Cloudflare AI model
            ragSystemPrompt = `You are a helpful, versatile, and conversational AI chat assistant powered by Cloudflare Workers AI.

CHAT GUIDELINES:
- This is a conversational AI chat box. Respond naturally, warmly, and helpfully.
- For simple greetings (such as "hi", "hello", "hey"), pleasantries, or casual small talk, respond concisely, warmly, and directly (e.g. "Hello! How can I help you today?").
- DO NOT overthink or output unnecessary, lengthy, unsolicited lectures, essays, or repetitive filler for simple greetings or casual queries.
- When the user asks specific, analytical, coding, or complex questions, provide clear, accurate, and well-structured answers tailored directly to what they requested.`
        }

        // Add current user message with prompt augmentation
        let finalUserContent = message
        if (attachedContexts.length > 0) {
            finalUserContent = `--- Attached Files Content ---\n${attachedContexts.join("\n\n")}\n\n${finalUserContent}`
        }
        if (contextChunks.length > 0) {
            const contextSummary = contextChunks
                .map(
                    (c, i) =>
                        `[Reference ${i + 1} (${c.name}${c.pageNumber ? ` - Page ${c.pageNumber}` : ""})]:\n${c.text}`
                )
                .join("\n\n")
            finalUserContent = `[Reference Material from Selected Document(s)]:\n${contextSummary}\n\n[User Question]:\n${finalUserContent}`
        }

        chatMessages.push({
            role: "user",
            content: finalUserContent,
        })

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

                // If user consulted selected documents and we have ground-truth pages, ensure the badge is present
                const relevantPages = Array.from(
                    new Set(
                        contextChunks
                            .map((c) => c.pageNumber)
                            .filter((p): p is number => typeof p === "number" && p > 0)
                    )
                ).sort((a, b) => a - b)

                if (hasSelectedDocs && relevantPages.length > 0) {
                    const hasPageCitation = /(?:📄|\bpages?\b|\bsource\b)\s*:?\s*\d+/i.test(
                        fullAssistantContent
                    )
                    if (!hasPageCitation) {
                        const badgeText =
                            relevantPages.length === 1
                                ? `\n\n📄 Page ${relevantPages[0]}`
                                : `\n\n📄 Pages ${relevantPages.join(", ")}`
                        fullAssistantContent += badgeText
                        await send({ delta: badgeText })
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
