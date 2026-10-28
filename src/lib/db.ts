import { env } from "cloudflare:workers"
import type { AppEnv, Conversation, D1DatabaseBinding, DocumentItem, Message } from "./types"

export class DatabaseBindingError extends Error {
    constructor(
        message: string = "D1 Database binding (DB) is missing or unconfigured. Please replace REPLACE_WITH_D1_ID in cloudflare.config.ts."
    ) {
        super(message)
        this.name = "DatabaseBindingError"
    }
}

export function getDb(override?: unknown): D1DatabaseBinding {
    const appEnv = env as unknown as AppEnv
    const db = (override as D1DatabaseBinding) || appEnv.DB
    if (!db || typeof db.prepare !== "function") {
        throw new DatabaseBindingError()
    }
    return db
}

export async function listConversations(dbOverride?: unknown): Promise<Conversation[]> {
    const db = getDb(dbOverride)
    try {
        const { results } = await db
            .prepare(
                "SELECT id, title, model, created_at, updated_at FROM conversations ORDER BY updated_at DESC"
            )
            .all<Conversation>()
        return results || []
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.includes("no such table") || msg.includes("REPLACE_WITH_D1_ID")) {
            throw new DatabaseBindingError(
                "D1 database tables are not initialized or database ID is a placeholder. Please run migrations."
            )
        }
        throw err
    }
}

export async function getConversation(
    id: string,
    dbOverride?: unknown
): Promise<Conversation | null> {
    const db = getDb(dbOverride)
    const conv = await db
        .prepare("SELECT id, title, model, created_at, updated_at FROM conversations WHERE id = ?")
        .bind(id)
        .first<Conversation>()
    return conv || null
}

export async function createConversation(
    id: string,
    title: string,
    model: string,
    dbOverride?: unknown
): Promise<Conversation> {
    const db = getDb(dbOverride)
    const now = Date.now()
    await db
        .prepare(
            "INSERT INTO conversations (id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
        )
        .bind(id, title, model, now, now)
        .run()
    return { id, title, model, created_at: now, updated_at: now }
}

export async function updateConversationTitle(
    id: string,
    title: string,
    dbOverride?: unknown
): Promise<void> {
    const db = getDb(dbOverride)
    const now = Date.now()
    await db
        .prepare("UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?")
        .bind(title, now, id)
        .run()
}

export async function touchConversation(id: string, dbOverride?: unknown): Promise<void> {
    const db = getDb(dbOverride)
    const now = Date.now()
    await db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").bind(now, id).run()
}

export async function deleteConversation(id: string, dbOverride?: unknown): Promise<void> {
    const db = getDb(dbOverride)
    try {
        await db.batch([
            db.prepare("DELETE FROM messages WHERE conversation_id = ?").bind(id),
            db.prepare("DELETE FROM documents WHERE conversation_id = ?").bind(id),
            db.prepare("DELETE FROM conversations WHERE id = ?").bind(id),
        ])
    } catch {
        await db.batch([
            db.prepare("DELETE FROM messages WHERE conversation_id = ?").bind(id),
            db.prepare("DELETE FROM conversations WHERE id = ?").bind(id),
        ])
    }
}

interface RawDbMessage {
    id: string
    conversation_id: string
    role: "user" | "assistant" | "system"
    content: string
    model?: string | null
    effort?: Message["effort"] | null
    attachments?: string | null
    created_at: number
}

export async function getMessages(
    conversationId: string,
    limit: number = 50,
    dbOverride?: unknown
): Promise<Message[]> {
    const db = getDb(dbOverride)
    const { results } = await db
        .prepare(
            "SELECT id, conversation_id, role, content, model, effort, attachments, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at ASC LIMIT ?"
        )
        .bind(conversationId, limit)
        .all<RawDbMessage>()

    return (results || []).map((row) => ({
        ...row,
        attachments: row.attachments ? JSON.parse(row.attachments) : null,
    }))
}

export async function createMessage(
    msg: Omit<Message, "created_at"> & { created_at?: number },
    dbOverride?: unknown
): Promise<Message> {
    const db = getDb(dbOverride)
    const now = msg.created_at || Date.now()
    const attachmentsJson = msg.attachments ? JSON.stringify(msg.attachments) : null

    await db
        .prepare(
            "INSERT INTO messages (id, conversation_id, role, content, model, effort, attachments, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .bind(
            msg.id,
            msg.conversation_id,
            msg.role,
            msg.content,
            msg.model || null,
            msg.effort || null,
            attachmentsJson,
            now
        )
        .run()

    await touchConversation(msg.conversation_id, db)

    return {
        ...msg,
        created_at: now,
    }
}

export async function listDocuments(
    conversationId?: string | null,
    dbOverride?: unknown
): Promise<DocumentItem[]> {
    const db = getDb(dbOverride)
    try {
        if (conversationId === undefined) {
            const { results } = await db
                .prepare(
                    "SELECT id, conversation_id, name, r2_key, mime, size, status, stage, progress, error_message, completed_at, chunk_count, created_at FROM documents ORDER BY created_at DESC"
                )
                .all<DocumentItem>()
            return results || []
        } else if (conversationId === null) {
            const { results } = await db
                .prepare(
                    "SELECT id, conversation_id, name, r2_key, mime, size, status, stage, progress, error_message, completed_at, chunk_count, created_at FROM documents WHERE conversation_id IS NULL OR conversation_id = '' ORDER BY created_at DESC"
                )
                .all<DocumentItem>()
            return results || []
        } else {
            const { results } = await db
                .prepare(
                    "SELECT id, conversation_id, name, r2_key, mime, size, status, stage, progress, error_message, completed_at, chunk_count, created_at FROM documents WHERE conversation_id = ? ORDER BY created_at DESC"
                )
                .bind(conversationId)
                .all<DocumentItem>()
            return results || []
        }
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.includes("no such column")) {
            try {
                const { results } = await db
                    .prepare(
                        "SELECT id, conversation_id, name, r2_key, mime, size, status, created_at FROM documents ORDER BY created_at DESC"
                    )
                    .all<DocumentItem>()
                return (results || []).map((row) => ({
                    ...row,
                    stage: row.status === "ready" ? "ready" : "upload",
                    progress: row.status === "ready" ? 100 : 0,
                }))
            } catch {
                const { results } = await db
                    .prepare(
                        "SELECT id, name, r2_key, mime, size, status, created_at FROM documents ORDER BY created_at DESC"
                    )
                    .all<DocumentItem>()
                return (results || []).map((row) => ({
                    ...row,
                    conversation_id: null,
                    stage: row.status === "ready" ? "ready" : "upload",
                    progress: row.status === "ready" ? 100 : 0,
                }))
            }
        }
        throw err
    }
}

export async function createDocument(doc: DocumentItem, dbOverride?: unknown): Promise<void> {
    const db = getDb(dbOverride)
    try {
        await db
            .prepare(
                "INSERT INTO documents (id, conversation_id, name, r2_key, mime, size, status, stage, progress, error_message, completed_at, chunk_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
            )
            .bind(
                doc.id,
                doc.conversation_id || null,
                doc.name,
                doc.r2_key,
                doc.mime,
                doc.size,
                doc.status,
                doc.stage || "upload",
                doc.progress ?? 0,
                doc.error_message || null,
                doc.completed_at || null,
                doc.chunk_count ?? 0,
                doc.created_at
            )
            .run()
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        if (
            msg.includes("has no column named") ||
            msg.includes("table documents has no column") ||
            msg.includes("no such column")
        ) {
            try {
                await db
                    .prepare(
                        "INSERT INTO documents (id, conversation_id, name, r2_key, mime, size, status, stage, progress, error_message, completed_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
                    )
                    .bind(
                        doc.id,
                        doc.conversation_id || null,
                        doc.name,
                        doc.r2_key,
                        doc.mime,
                        doc.size,
                        doc.status,
                        doc.stage || "upload",
                        doc.progress ?? 0,
                        doc.error_message || null,
                        doc.completed_at || null,
                        doc.created_at
                    )
                    .run()
                return
            } catch {}
            try {
                await db
                    .prepare(
                        "INSERT INTO documents (id, conversation_id, name, r2_key, mime, size, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
                    )
                    .bind(
                        doc.id,
                        doc.conversation_id || null,
                        doc.name,
                        doc.r2_key,
                        doc.mime,
                        doc.size,
                        doc.status,
                        doc.created_at
                    )
                    .run()
                return
            } catch {
                await db
                    .prepare(
                        "INSERT INTO documents (id, name, r2_key, mime, size, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
                    )
                    .bind(
                        doc.id,
                        doc.name,
                        doc.r2_key,
                        doc.mime,
                        doc.size,
                        doc.status,
                        doc.created_at
                    )
                    .run()
                return
            }
        }
        throw err
    }
}

export async function getDocument(id: string, dbOverride?: unknown): Promise<DocumentItem | null> {
    const db = getDb(dbOverride)
    try {
        const doc = await db
            .prepare(
                "SELECT id, conversation_id, name, r2_key, mime, size, status, stage, progress, error_message, completed_at, chunk_count, created_at FROM documents WHERE id = ?"
            )
            .bind(id)
            .first<DocumentItem>()
        return doc || null
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.includes("no such column")) {
            try {
                const doc = await db
                    .prepare(
                        "SELECT id, conversation_id, name, r2_key, mime, size, status, created_at FROM documents WHERE id = ?"
                    )
                    .bind(id)
                    .first<DocumentItem>()
                return doc
                    ? {
                          ...doc,
                          stage: doc.status === "ready" ? "ready" : "upload",
                          progress: doc.status === "ready" ? 100 : 0,
                      }
                    : null
            } catch {
                const doc = await db
                    .prepare(
                        "SELECT id, name, r2_key, mime, size, status, created_at FROM documents WHERE id = ?"
                    )
                    .bind(id)
                    .first<DocumentItem>()
                return doc
                    ? {
                          ...doc,
                          conversation_id: null,
                          stage: doc.status === "ready" ? "ready" : "upload",
                          progress: doc.status === "ready" ? 100 : 0,
                      }
                    : null
            }
        }
        throw err
    }
}

export async function updateDocumentProgress(
    id: string,
    updates: {
        status?: DocumentItem["status"]
        stage?: DocumentItem["stage"]
        progress?: number
        error_message?: string | null
        completed_at?: number | null
        chunk_count?: number | null
    },
    dbOverride?: unknown
): Promise<void> {
    const db = getDb(dbOverride)
    const setClauses: string[] = []
    const values: unknown[] = []

    if (updates.status !== undefined) {
        setClauses.push("status = ?")
        values.push(updates.status)
    }
    if (updates.stage !== undefined) {
        setClauses.push("stage = ?")
        values.push(updates.stage)
    }
    if (updates.progress !== undefined) {
        setClauses.push("progress = ?")
        values.push(updates.progress)
    }
    if (updates.error_message !== undefined) {
        setClauses.push("error_message = ?")
        values.push(updates.error_message)
    }
    if (updates.completed_at !== undefined) {
        setClauses.push("completed_at = ?")
        values.push(updates.completed_at)
    }
    if (updates.chunk_count !== undefined) {
        setClauses.push("chunk_count = ?")
        values.push(updates.chunk_count)
    }

    if (setClauses.length === 0) return

    values.push(id)
    try {
        await db
            .prepare(`UPDATE documents SET ${setClauses.join(", ")} WHERE id = ?`)
            .bind(...values)
            .run()
    } catch {
        // Fallback if processing columns are not yet migrated in current DB
        if (updates.status !== undefined) {
            try {
                await db
                    .prepare("UPDATE documents SET status = ? WHERE id = ?")
                    .bind(updates.status, id)
                    .run()
            } catch {}
        }
    }
}

export async function failDocument(
    id: string,
    errorMessage: string,
    stage: DocumentItem["stage"] = "failed",
    dbOverride?: unknown
): Promise<void> {
    await updateDocumentProgress(
        id,
        {
            status: "failed",
            stage,
            error_message: errorMessage,
            completed_at: Date.now(),
        },
        dbOverride
    )
}

export async function deleteDocument(id: string, dbOverride?: unknown): Promise<void> {
    const db = getDb(dbOverride)
    await db.prepare("DELETE FROM documents WHERE id = ?").bind(id).run()
}

export async function deleteDocuments(ids: string[], dbOverride?: unknown): Promise<void> {
    if (!ids || ids.length === 0) return
    const db = getDb(dbOverride)
    const statements = ids.map((id) => db.prepare("DELETE FROM documents WHERE id = ?").bind(id))
    await db.batch(statements)
}

export interface ModelUsageBreakdown {
    model: string
    requests: number
    inputTokens: number
    outputTokens: number
    estimatedNeurons: number
    requiredPlan: string
}

export interface DailyUsageSummary {
    dateUtc: string
    resetAtUtc: string
    dailyFreeNeuronsLimit: number
    estimatedNeuronsUsedToday: number
    remainingNeuronsToday: number
    percentUsed: number
    totalRequestsToday: number
    totalInputTokensToday: number
    totalOutputTokensToday: number
    allTimeMessages: number
    allTimeDocuments: number
    byModel: Record<string, ModelUsageBreakdown>
}

export const MODEL_NEURON_RATES: Record<
    string,
    { inputRate: number; outputRate: number; requiredPlan: string }
> = {
    // Fast / Small
    "@cf/meta/llama-3.2-3b-instruct": {
        inputRate: 30000,
        outputRate: 200000,
        requiredPlan: "Free",
    },
    "@cf/meta/llama-3.2-1b-instruct": {
        inputRate: 20000,
        outputRate: 150000,
        requiredPlan: "Free",
    },
    "@cf/microsoft/phi-2": { inputRate: 25000, outputRate: 180000, requiredPlan: "Free" },
    "@cf/tinyllama/tinyllama-1.1b-chat-v1.0": {
        inputRate: 15000,
        outputRate: 100000,
        requiredPlan: "Free",
    },

    // General
    "@cf/meta/llama-3.1-8b-instruct": {
        inputRate: 50000,
        outputRate: 250000,
        requiredPlan: "Free",
    },
    "@cf/meta/llama-3-8b-instruct": { inputRate: 45000, outputRate: 220000, requiredPlan: "Free" },
    "@cf/mistral/mistral-7b-instruct-v0.1": {
        inputRate: 40000,
        outputRate: 220000,
        requiredPlan: "Free",
    },
    "@cf/google/gemma-7b-it": { inputRate: 40000, outputRate: 250000, requiredPlan: "Free" },
    "@cf/openchat/openchat-3.5-0106": {
        inputRate: 40000,
        outputRate: 220000,
        requiredPlan: "Free",
    },

    // Reasoning
    "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b": {
        inputRate: 100000,
        outputRate: 500000,
        requiredPlan: "Paid",
    },
    "@cf/qwen/qwen2.5-coder-32b-instruct": {
        inputRate: 90000,
        outputRate: 450000,
        requiredPlan: "Paid",
    },

    // Vision
    "@cf/meta/llama-3.2-11b-vision-instruct": {
        inputRate: 80000,
        outputRate: 400000,
        requiredPlan: "Paid",
    },
}

export async function getUsageMetrics(dbOverride?: unknown): Promise<DailyUsageSummary> {
    const db = getDb(dbOverride)
    const now = new Date()
    const todayUtcMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
    const resetAtUtc = new Date(todayUtcMidnight + 86400000).toISOString()

    // Fetch messages created today
    const { results: todayMessages } = await db
        .prepare(
            "SELECT role, content, model, created_at FROM messages WHERE created_at >= ? ORDER BY created_at ASC"
        )
        .bind(todayUtcMidnight)
        .all<{ role?: string; content?: string; model?: string; created_at?: number }>()

    // Fetch all time counts
    const totalMsgsRow = await db
        .prepare("SELECT COUNT(*) as count FROM messages")
        .first<{ count: number }>()
    const allTimeMessages = Number(totalMsgsRow?.count || 0)

    const totalDocsRow = await db
        .prepare("SELECT COUNT(*) as count FROM documents")
        .first<{ count: number }>()
    const allTimeDocuments = Number(totalDocsRow?.count || 0)

    const byModel: Record<string, ModelUsageBreakdown> = {}
    let totalInputTokensToday = 0
    let totalOutputTokensToday = 0
    let estimatedNeuronsUsedToday = 0
    let totalRequestsToday = 0

    for (const row of todayMessages || []) {
        const model = row.model || "@cf/meta/llama-3.1-8b-instruct"
        const rates = MODEL_NEURON_RATES[model] || {
            inputRate: 50000,
            outputRate: 300000,
            requiredPlan: "Free",
        }

        if (!byModel[model]) {
            byModel[model] = {
                model,
                requests: 0,
                inputTokens: 0,
                outputTokens: 0,
                estimatedNeurons: 0,
                requiredPlan: rates.requiredPlan,
            }
        }

        const contentLength = (row.content || "").length
        const estTokens = Math.max(1, Math.ceil(contentLength / 4))

        if (row.role === "assistant") {
            totalRequestsToday += 1
            byModel[model].requests += 1
            byModel[model].outputTokens += estTokens
            totalOutputTokensToday += estTokens
            // Output tokens neuron cost: (tokens / 1,000,000) * outputRate
            const neuronCost = Math.round((estTokens / 1000000) * rates.outputRate)
            byModel[model].estimatedNeurons += neuronCost
            estimatedNeuronsUsedToday += neuronCost
        } else {
            byModel[model].inputTokens += estTokens
            totalInputTokensToday += estTokens
            const neuronCost = Math.round((estTokens / 1000000) * rates.inputRate)
            byModel[model].estimatedNeurons += neuronCost
            estimatedNeuronsUsedToday += neuronCost
        }
    }

    const dailyFreeNeuronsLimit = 10000
    const remainingNeuronsToday = Math.max(0, dailyFreeNeuronsLimit - estimatedNeuronsUsedToday)
    const percentUsed = Math.min(
        100,
        Math.round((estimatedNeuronsUsedToday / dailyFreeNeuronsLimit) * 100)
    )

    return {
        dateUtc: new Date(todayUtcMidnight).toISOString().split("T")[0],
        resetAtUtc,
        dailyFreeNeuronsLimit,
        estimatedNeuronsUsedToday,
        remainingNeuronsToday,
        percentUsed,
        totalRequestsToday,
        totalInputTokensToday,
        totalOutputTokensToday,
        allTimeMessages,
        allTimeDocuments,
        byModel,
    }
}
