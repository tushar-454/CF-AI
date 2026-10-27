export type ModelCategory = "General" | "Reasoning" | "Coding" | "Vision" | "Fast/Small"

export type EffortLevel = "low" | "medium" | "high"

export type ContextMode = "none" | "conversation" | "knowledge" | "files"

export interface ModelInfo {
    id: string
    label: string
    category: ModelCategory
    description: string
    supportsStreaming: boolean
    supportsVision: boolean
    supportsReasoning: boolean
    contextWindow: number
}

export interface Attachment {
    id: string
    name: string
    mime: string
    size: number
    r2_key: string
    isImage: boolean
    isPdf?: boolean
    url?: string
    textContent?: string
}

export interface Message {
    id: string
    conversation_id: string
    role: "user" | "assistant" | "system"
    content: string
    model?: string | null
    effort?: EffortLevel | null
    attachments?: Attachment[] | null
    created_at: number
    reasoning?: string | null
}

export interface Conversation {
    id: string
    title: string
    model: string
    created_at: number
    updated_at: number
    messages?: Message[]
}

export interface DocumentItem {
    id: string
    conversation_id?: string | null
    name: string
    r2_key: string
    mime: string
    size: number
    status: "ready" | "processing" | "error" | "image"
    created_at: number
}

export interface ChatRequestBody {
    conversationId?: string
    message: string
    model?: string
    effort?: EffortLevel
    contextMode?: ContextMode
    attachments?: Attachment[]
}

export interface WorkersAi {
    run: (model: string, inputs: Record<string, unknown> | unknown) => Promise<unknown>
}

export interface D1PreparedStatement {
    bind(...values: unknown[]): D1PreparedStatement
    first<T = Record<string, unknown>>(colName?: string): Promise<T | null>
    all<T = Record<string, unknown>>(): Promise<{ results: T[]; success: boolean; meta?: unknown }>
    run(): Promise<{ success: boolean; meta?: unknown }>
}

export interface D1DatabaseBinding {
    prepare(query: string): D1PreparedStatement
    batch(statements: D1PreparedStatement[]): Promise<{ results?: unknown[]; success: boolean }[]>
    exec(query: string): Promise<{ count: number; duration: number }>
}

export interface R2ObjectBinding {
    key: string
    size: number
    body: ReadableStream
    arrayBuffer: () => Promise<ArrayBuffer>
    text?: () => Promise<string>
    httpMetadata?: {
        contentType?: string
    }
    customMetadata?: Record<string, string>
}

export interface R2BucketBinding {
    get(key: string): Promise<R2ObjectBinding | null>
    put(
        key: string,
        value: ArrayBuffer | ArrayBufferView | ReadableStream | string | Blob,
        options?: {
            httpMetadata?: { contentType?: string }
            customMetadata?: Record<string, string>
        }
    ): Promise<unknown>
    delete(keys: string | string[]): Promise<void>
    list(options?: { prefix?: string; limit?: number; cursor?: string }): Promise<{
        objects: Array<{ key: string; size: number }>
        truncated: boolean
    }>
}

export interface VectorizeMatch {
    id: string
    score: number
    values?: number[]
    metadata?: Record<string, unknown>
}

export interface VectorizeQueryResult {
    matches: VectorizeMatch[]
    count: number
}

export interface VectorizeIndexBinding {
    query(
        vector: number[],
        options?: { topK?: number; returnMetadata?: string; filter?: Record<string, unknown> }
    ): Promise<VectorizeQueryResult>
    upsert(
        records: Array<{
            id: string
            values: number[]
            metadata?: Record<string, unknown>
        }>
    ): Promise<unknown>
    deleteByIds(ids: string[]): Promise<unknown>
}

export interface AppEnv {
    AI?: WorkersAi
    DB?: D1DatabaseBinding
    FILES?: R2BucketBinding
    VECTORIZE?: VectorizeIndexBinding
    ASSETS?: unknown
    IMAGES?: unknown
    APP_PIN?: string
    R2_BUCKET?: string
    R2_ACCESS_KEY_ID?: string
    R2_SECRET_ACCESS_KEY?: string
    R2_ENDPOINT?: string
    R2_PUBLIC_URL?: string
    CLOUDFLARE_ACCOUNT_ID?: string
    CLOUDFLARE_API_TOKEN?: string
}
