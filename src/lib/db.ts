import { env } from "cloudflare:workers";
import { Conversation, DocumentItem, Message } from "./types";

export class DatabaseBindingError extends Error {
  constructor(message: string = "D1 Database binding (DB) is missing or unconfigured. Please replace REPLACE_WITH_D1_ID in cloudflare.config.ts.") {
    super(message);
    this.name = "DatabaseBindingError";
  }
}

export function getDb(override?: any): any {
  const db = override || (env as any)?.DB;
  if (!db || typeof db.prepare !== "function") {
    throw new DatabaseBindingError();
  }
  return db;
}

export async function listConversations(dbOverride?: any): Promise<Conversation[]> {
  const db = getDb(dbOverride);
  try {
    const { results } = await db
      .prepare("SELECT id, title, model, created_at, updated_at FROM conversations ORDER BY updated_at DESC")
      .all();
    return (results as any[]) || [];
  } catch (err: any) {
    if (err?.message?.includes("no such table") || err?.message?.includes("REPLACE_WITH_D1_ID")) {
      throw new DatabaseBindingError("D1 database tables are not initialized or database ID is a placeholder. Please run migrations.");
    }
    throw err;
  }
}

export async function getConversation(id: string, dbOverride?: any): Promise<Conversation | null> {
  const db = getDb(dbOverride);
  const conv = await db
    .prepare("SELECT id, title, model, created_at, updated_at FROM conversations WHERE id = ?")
    .bind(id)
    .first();
  return (conv as unknown as Conversation) || null;
}

export async function createConversation(
  id: string,
  title: string,
  model: string,
  dbOverride?: any
): Promise<Conversation> {
  const db = getDb(dbOverride);
  const now = Date.now();
  await db
    .prepare("INSERT INTO conversations (id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
    .bind(id, title, model, now, now)
    .run();
  return { id, title, model, created_at: now, updated_at: now };
}

export async function updateConversationTitle(id: string, title: string, dbOverride?: any): Promise<void> {
  const db = getDb(dbOverride);
  const now = Date.now();
  await db
    .prepare("UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?")
    .bind(title, now, id)
    .run();
}

export async function touchConversation(id: string, dbOverride?: any): Promise<void> {
  const db = getDb(dbOverride);
  const now = Date.now();
  await db
    .prepare("UPDATE conversations SET updated_at = ? WHERE id = ?")
    .bind(now, id)
    .run();
}

export async function deleteConversation(id: string, dbOverride?: any): Promise<void> {
  const db = getDb(dbOverride);
  await db.batch([
    db.prepare("DELETE FROM messages WHERE conversation_id = ?").bind(id),
    db.prepare("DELETE FROM conversations WHERE id = ?").bind(id),
  ]);
}

export async function getMessages(
  conversationId: string,
  limit: number = 50,
  dbOverride?: any
): Promise<Message[]> {
  const db = getDb(dbOverride);
  const { results } = await db
    .prepare(
      "SELECT id, conversation_id, role, content, model, effort, attachments, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at ASC LIMIT ?"
    )
    .bind(conversationId, limit)
    .all();

  return ((results as any[]) || []).map((row) => ({
    ...row,
    attachments: row.attachments ? JSON.parse(row.attachments) : null,
  }));
}

export async function createMessage(
  msg: Omit<Message, "created_at"> & { created_at?: number },
  dbOverride?: any
): Promise<Message> {
  const db = getDb(dbOverride);
  const now = msg.created_at || Date.now();
  const attachmentsJson = msg.attachments ? JSON.stringify(msg.attachments) : null;

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
    .run();

  await touchConversation(msg.conversation_id, db);

  return {
    ...msg,
    created_at: now,
  };
}

export async function listDocuments(dbOverride?: any): Promise<DocumentItem[]> {
  const db = getDb(dbOverride);
  const { results } = await db
    .prepare("SELECT id, name, r2_key, mime, size, status, created_at FROM documents ORDER BY created_at DESC")
    .all();
  return (results as any[]) || [];
}

export async function createDocument(doc: DocumentItem, dbOverride?: any): Promise<void> {
  const db = getDb(dbOverride);
  await db
    .prepare("INSERT INTO documents (id, name, r2_key, mime, size, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(doc.id, doc.name, doc.r2_key, doc.mime, doc.size, doc.status, doc.created_at)
    .run();
}

export async function getDocument(id: string, dbOverride?: any): Promise<DocumentItem | null> {
  const db = getDb(dbOverride);
  const doc = await db
    .prepare("SELECT id, name, r2_key, mime, size, status, created_at FROM documents WHERE id = ?")
    .bind(id)
    .first();
  return (doc as unknown as DocumentItem) || null;
}

export async function deleteDocument(id: string, dbOverride?: any): Promise<void> {
  const db = getDb(dbOverride);
  await db.prepare("DELETE FROM documents WHERE id = ?").bind(id).run();
}

export interface ModelUsageBreakdown {
  model: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  estimatedNeurons: number;
  requiredPlan: string;
}

export interface DailyUsageSummary {
  dateUtc: string;
  resetAtUtc: string;
  dailyFreeNeuronsLimit: number;
  estimatedNeuronsUsedToday: number;
  remainingNeuronsToday: number;
  percentUsed: number;
  totalRequestsToday: number;
  totalInputTokensToday: number;
  totalOutputTokensToday: number;
  allTimeMessages: number;
  allTimeDocuments: number;
  byModel: Record<string, ModelUsageBreakdown>;
}

export const MODEL_NEURON_RATES: Record<string, { inputRate: number; outputRate: number; requiredPlan: string }> = {
  // Fast / Small
  "@cf/meta/llama-3.2-3b-instruct": { inputRate: 30000, outputRate: 200000, requiredPlan: "Free" },
  "@cf/meta/llama-3.2-1b-instruct": { inputRate: 20000, outputRate: 150000, requiredPlan: "Free" },
  "@cf/microsoft/phi-2": { inputRate: 25000, outputRate: 180000, requiredPlan: "Free" },
  "@cf/tinyllama/tinyllama-1.1b-chat-v1.0": { inputRate: 15000, outputRate: 100000, requiredPlan: "Free" },

  // General
  "@cf/meta/llama-3.1-8b-instruct": { inputRate: 50000, outputRate: 250000, requiredPlan: "Free" },
  "@cf/meta/llama-3-8b-instruct": { inputRate: 45000, outputRate: 220000, requiredPlan: "Free" },
  "@cf/mistral/mistral-7b-instruct-v0.1": { inputRate: 40000, outputRate: 220000, requiredPlan: "Free" },
  "@cf/google/gemma-7b-it": { inputRate: 40000, outputRate: 250000, requiredPlan: "Free" },
  "@cf/openchat/openchat-3.5-0106": { inputRate: 40000, outputRate: 220000, requiredPlan: "Free" },

  // Reasoning
  "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b": { inputRate: 100000, outputRate: 400000, requiredPlan: "Free" },
  "@cf/qwen/qwq-32b": { inputRate: 100000, outputRate: 400000, requiredPlan: "Free" },
  "@cf/openai/gpt-oss-20b": { inputRate: 80000, outputRate: 350000, requiredPlan: "Free" },

  // Coding
  "@cf/qwen/qwen2.5-coder-32b-instruct": { inputRate: 100000, outputRate: 400000, requiredPlan: "Free" },

  // Vision
  "@cf/meta/llama-3.2-11b-vision-instruct": { inputRate: 60000, outputRate: 300000, requiredPlan: "Free" },

  // Historic / Reference
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast": { inputRate: 200000, outputRate: 700000, requiredPlan: "Paid" },
};

export async function getUsageMetrics(dbOverride?: any): Promise<DailyUsageSummary> {
  const db = getDb(dbOverride);
  const now = new Date();
  const todayUtcMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const resetAtUtc = new Date(todayUtcMidnight + 86400000).toISOString();

  // Fetch messages created today
  const { results: todayMessages } = await db
    .prepare("SELECT role, content, model, created_at FROM messages WHERE created_at >= ? ORDER BY created_at ASC")
    .bind(todayUtcMidnight)
    .all();

  // Fetch all time counts
  const totalMsgsRow = await db.prepare("SELECT COUNT(*) as count FROM messages").first();
  const allTimeMessages = Number(totalMsgsRow?.count || 0);

  const totalDocsRow = await db.prepare("SELECT COUNT(*) as count FROM documents").first();
  const allTimeDocuments = Number(totalDocsRow?.count || 0);

  const byModel: Record<string, ModelUsageBreakdown> = {};
  let totalInputTokensToday = 0;
  let totalOutputTokensToday = 0;
  let estimatedNeuronsUsedToday = 0;
  let totalRequestsToday = 0;

  for (const row of (todayMessages as any[]) || []) {
    const model = row.model || "@cf/meta/llama-3.1-8b-instruct";
    const rates = MODEL_NEURON_RATES[model] || { inputRate: 50000, outputRate: 300000, requiredPlan: "Free" };

    if (!byModel[model]) {
      byModel[model] = {
        model,
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        estimatedNeurons: 0,
        requiredPlan: rates.requiredPlan,
      };
    }

    const contentLength = (row.content || "").length;
    const estTokens = Math.max(1, Math.ceil(contentLength / 4));

    if (row.role === "assistant") {
      totalRequestsToday += 1;
      byModel[model].requests += 1;
      byModel[model].outputTokens += estTokens;
      totalOutputTokensToday += estTokens;
      const neurons = (estTokens / 1_000_000) * rates.outputRate;
      byModel[model].estimatedNeurons += neurons;
      estimatedNeuronsUsedToday += neurons;
    } else if (row.role === "user") {
      byModel[model].inputTokens += estTokens;
      totalInputTokensToday += estTokens;
      const neurons = (estTokens / 1_000_000) * rates.inputRate;
      byModel[model].estimatedNeurons += neurons;
      estimatedNeuronsUsedToday += neurons;
    }
  }

  // Round estimated neurons
  estimatedNeuronsUsedToday = Math.round(estimatedNeuronsUsedToday * 100) / 100;
  for (const m of Object.keys(byModel)) {
    byModel[m].estimatedNeurons = Math.round(byModel[m].estimatedNeurons * 100) / 100;
  }

  const dailyFreeNeuronsLimit = 10000;
  const remainingNeuronsToday = Math.max(0, Math.round((dailyFreeNeuronsLimit - estimatedNeuronsUsedToday) * 100) / 100);
  const percentUsed = Math.min(100, Math.round((estimatedNeuronsUsedToday / dailyFreeNeuronsLimit) * 100));

  return {
    dateUtc: new Date(todayUtcMidnight).toISOString().slice(0, 10),
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
  };
}

