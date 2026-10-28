import { env } from "cloudflare:workers"
import type {
    AppEnv,
    Conversation,
    D1DatabaseBinding,
    DocumentItem,
    Message,
    YoutubeChunk,
    YoutubeVideoItem,
    YoutubeVideoStage,
} from "./types"

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

export async function listConversations(
    type?: "chat" | "youtube",
    dbOverride?: unknown
): Promise<Conversation[]> {
    const db = getDb(dbOverride)
    try {
        if (type === "youtube") {
            const { results } = await db
                .prepare(
                    "SELECT id, title, model, type, video_id, created_at, updated_at FROM conversations WHERE type = 'youtube' ORDER BY updated_at DESC"
                )
                .all<Conversation>()
            return results || []
        } else if (type === "chat") {
            const { results } = await db
                .prepare(
                    "SELECT id, title, model, type, video_id, created_at, updated_at FROM conversations WHERE type != 'youtube' OR type IS NULL ORDER BY updated_at DESC"
                )
                .all<Conversation>()
            return results || []
        }

        const { results } = await db
            .prepare(
                "SELECT id, title, model, type, video_id, created_at, updated_at FROM conversations ORDER BY updated_at DESC"
            )
            .all<Conversation>()
        return results || []
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.includes("no such column")) {
            const { results } = await db
                .prepare(
                    "SELECT id, title, model, created_at, updated_at FROM conversations ORDER BY updated_at DESC"
                )
                .all<Conversation>()
            return results || []
        }
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
    try {
        const conv = await db
            .prepare(
                "SELECT id, title, model, type, video_id, created_at, updated_at FROM conversations WHERE id = ?"
            )
            .bind(id)
            .first<Conversation>()
        return conv || null
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.includes("no such column")) {
            const conv = await db
                .prepare(
                    "SELECT id, title, model, created_at, updated_at FROM conversations WHERE id = ?"
                )
                .bind(id)
                .first<Conversation>()
            return conv || null
        }
        throw err
    }
}

export async function createConversation(
    id: string,
    title: string,
    model: string,
    type: "chat" | "youtube" = "chat",
    videoId?: string | null,
    dbOverride?: unknown
): Promise<Conversation> {
    const db = getDb(dbOverride)
    const now = Date.now()
    try {
        await db
            .prepare(
                "INSERT INTO conversations (id, title, model, type, video_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
            )
            .bind(id, title, model, type, videoId || null, now, now)
            .run()
        return {
            id,
            title,
            model,
            type,
            video_id: videoId || null,
            created_at: now,
            updated_at: now,
        }
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.includes("no such column")) {
            await db
                .prepare(
                    "INSERT INTO conversations (id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
                )
                .bind(id, title, model, now, now)
                .run()
            return { id, title, model, created_at: now, updated_at: now }
        }
        throw err
    }
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
    citations?: string | null
    created_at: number
}

export async function getMessages(
    conversationId: string,
    limit: number = 50,
    dbOverride?: unknown
): Promise<Message[]> {
    const db = getDb(dbOverride)
    try {
        const { results } = await db
            .prepare(
                "SELECT id, conversation_id, role, content, model, effort, attachments, citations, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at ASC LIMIT ?"
            )
            .bind(conversationId, limit)
            .all<RawDbMessage>()

        return (results || []).map((row) => ({
            ...row,
            attachments: row.attachments ? JSON.parse(row.attachments) : null,
            citations: row.citations ? JSON.parse(row.citations) : null,
        }))
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.includes("no such column")) {
            const { results } = await db
                .prepare(
                    "SELECT id, conversation_id, role, content, model, effort, attachments, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at ASC LIMIT ?"
                )
                .bind(conversationId, limit)
                .all<RawDbMessage>()

            return (results || []).map((row) => ({
                ...row,
                attachments: row.attachments ? JSON.parse(row.attachments) : null,
                citations: null,
            }))
        }
        throw err
    }
}

export async function createMessage(
    msg: Omit<Message, "created_at"> & { created_at?: number },
    dbOverride?: unknown
): Promise<Message> {
    const db = getDb(dbOverride)
    const now = msg.created_at || Date.now()
    const attachmentsJson = msg.attachments ? JSON.stringify(msg.attachments) : null
    const citationsJson = msg.citations ? JSON.stringify(msg.citations) : null

    try {
        await db
            .prepare(
                "INSERT INTO messages (id, conversation_id, role, content, model, effort, attachments, citations, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
            )
            .bind(
                msg.id,
                msg.conversation_id,
                msg.role,
                msg.content,
                msg.model || null,
                msg.effort || null,
                attachmentsJson,
                citationsJson,
                now
            )
            .run()
    } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err)
        if (errMsg.includes("no such column") || errMsg.includes("has no column named citations")) {
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
        } else {
            throw err
        }
    }

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

// ---------------------------------------------------------------------------
// YouTube Video Knowledge Base Database Access
// ---------------------------------------------------------------------------

export async function getYoutubeVideo(
    id: string,
    dbOverride?: unknown
): Promise<YoutubeVideoItem | null> {
    const db = getDb(dbOverride)
    try {
        const video = await db
            .prepare(
                "SELECT id, title, url, channel_title, duration, thumbnail_url, transcript_lang, transcript_source, transcript_version, status, stage, progress, error_message, embedding_model, chunk_count, created_at, updated_at, completed_at FROM youtube_videos WHERE id = ?"
            )
            .bind(id)
            .first<YoutubeVideoItem>()
        return video || null
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.includes("no such table")) {
            return null
        }
        throw err
    }
}

export async function createYoutubeVideo(
    video: YoutubeVideoItem,
    dbOverride?: unknown
): Promise<void> {
    const db = getDb(dbOverride)
    await db
        .prepare(
            `INSERT INTO youtube_videos (
                id, title, url, channel_title, duration, thumbnail_url,
                transcript_lang, transcript_source, transcript_version,
                status, stage, progress, error_message, embedding_model,
                chunk_count, created_at, updated_at, completed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                title = excluded.title,
                url = excluded.url,
                status = excluded.status,
                stage = excluded.stage,
                progress = excluded.progress,
                error_message = excluded.error_message,
                updated_at = excluded.updated_at`
        )
        .bind(
            video.id,
            video.title,
            video.url,
            video.channel_title || null,
            video.duration || 0,
            video.thumbnail_url || null,
            video.transcript_lang || null,
            video.transcript_source || null,
            video.transcript_version || 1,
            video.status,
            video.stage || "validating",
            video.progress ?? 0,
            video.error_message || null,
            video.embedding_model,
            video.chunk_count ?? 0,
            video.created_at,
            video.updated_at,
            video.completed_at || null
        )
        .run()
}

export async function updateYoutubeVideoProgress(
    id: string,
    updates: Partial<YoutubeVideoItem>,
    dbOverride?: unknown
): Promise<void> {
    const db = getDb(dbOverride)
    const setClauses: string[] = []
    const values: unknown[] = []

    if (updates.title !== undefined) {
        setClauses.push("title = ?")
        values.push(updates.title)
    }
    if (updates.duration !== undefined) {
        setClauses.push("duration = ?")
        values.push(updates.duration)
    }
    if (updates.channel_title !== undefined) {
        setClauses.push("channel_title = ?")
        values.push(updates.channel_title)
    }
    if (updates.thumbnail_url !== undefined) {
        setClauses.push("thumbnail_url = ?")
        values.push(updates.thumbnail_url)
    }
    if (updates.transcript_lang !== undefined) {
        setClauses.push("transcript_lang = ?")
        values.push(updates.transcript_lang)
    }
    if (updates.transcript_source !== undefined) {
        setClauses.push("transcript_source = ?")
        values.push(updates.transcript_source)
    }
    if (updates.transcript_version !== undefined) {
        setClauses.push("transcript_version = ?")
        values.push(updates.transcript_version)
    }
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
    if (updates.chunk_count !== undefined) {
        setClauses.push("chunk_count = ?")
        values.push(updates.chunk_count)
    }
    if (updates.completed_at !== undefined) {
        setClauses.push("completed_at = ?")
        values.push(updates.completed_at)
    }

    setClauses.push("updated_at = ?")
    values.push(Date.now())

    values.push(id)

    await db
        .prepare(`UPDATE youtube_videos SET ${setClauses.join(", ")} WHERE id = ?`)
        .bind(...values)
        .run()
}

export async function failYoutubeVideo(
    id: string,
    errorMessage: string,
    stage: YoutubeVideoStage = "failed",
    dbOverride?: unknown
): Promise<void> {
    await updateYoutubeVideoProgress(
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

export async function getYoutubeChunks(
    videoId: string,
    dbOverride?: unknown
): Promise<YoutubeChunk[]> {
    const db = getDb(dbOverride)
    try {
        const { results } = await db
            .prepare(
                "SELECT id, video_id as videoId, chunk_index as chunkIndex, start_seconds as startSeconds, end_seconds as endSeconds, text FROM youtube_chunks WHERE video_id = ? ORDER BY chunk_index ASC"
            )
            .bind(videoId)
            .all<YoutubeChunk>()
        return results || []
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.includes("no such table")) {
            return []
        }
        throw err
    }
}

export async function saveYoutubeChunks(
    videoId: string,
    chunks: YoutubeChunk[],
    dbOverride?: unknown
): Promise<void> {
    if (!chunks || chunks.length === 0) return
    const db = getDb(dbOverride)
    const now = Date.now()

    // Delete existing chunks for idempotent upsert
    try {
        await db.prepare("DELETE FROM youtube_chunks WHERE video_id = ?").bind(videoId).run()
    } catch {}

    const statements = chunks.map((chunk) =>
        db
            .prepare(
                "INSERT INTO youtube_chunks (id, video_id, chunk_index, start_seconds, end_seconds, text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
            )
            .bind(
                chunk.id,
                videoId,
                chunk.chunkIndex,
                chunk.startSeconds,
                chunk.endSeconds,
                chunk.text,
                now
            )
    )

    // Batch execute
    const batchSize = 50
    for (let i = 0; i < statements.length; i += batchSize) {
        await db.batch(statements.slice(i, i + batchSize))
    }
}
