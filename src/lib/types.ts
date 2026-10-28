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
    status?: DocumentStatus
    stage?: DocumentStage
    progress?: number
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
    citations?: import("./youtube-types").Citation[] | null
}

export interface Conversation {
    id: string
    title: string
    model: string
    type?: "chat" | "youtube"
    video_id?: string | null
    created_at: number
    updated_at: number
    messages?: Message[]
}

export type DocumentStatus = "queued" | "processing" | "ready" | "failed" | "image" | "error"
export type DocumentStage =
    "upload" | "extraction" | "chunking" | "embedding" | "indexing" | "ready" | "failed"

export interface DocumentProgressEvent {
    documentId: string
    status: DocumentStatus
    stage: DocumentStage
    progress: number
    message?: string
    error?: string
    completedAt?: number
    timestamp: number
    chunksIndexed?: number
    totalChunks?: number
    diagnostic?: import("./youtube-types").YoutubeDiagnosticEvent
}

export interface DocumentItem {
    id: string
    conversation_id?: string | null
    name: string
    r2_key: string
    mime: string
    size: number
    status: DocumentStatus
    stage?: DocumentStage
    progress?: number
    error_message?: string | null
    completed_at?: number | null
    chunk_count?: number | null
    created_at: number
}

export interface UploadInitRequest {
    filename: string
    mime: string
    size: number
    conversationId?: string | null
}

export interface UploadInitResponse {
    mode: "presigned" | "stream"
    documentId: string
    r2Key: string
    uploadUrl: string
    headers?: Record<string, string>
    maxSizeBytes: number
}

export interface UploadCompleteRequest {
    documentId: string
    filename: string
    conversationId?: string | null
    mime?: string
}

export interface UploadCompleteResponse {
    document: DocumentItem
    isPdf: boolean
    progressUrl?: string
}

export interface ChatRequestBody {
    conversationId?: string
    message: string
    model?: string
    effort?: EffortLevel
    contextMode?: ContextMode
    attachments?: Attachment[]
    selectedDocumentIds?: string[]
    createdAt?: number
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

export interface DocumentChunk {
    text: string
    pageNumber?: number
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

export interface WorkflowInstanceBinding {
    create: (options: { id?: string; params: unknown }) => Promise<{ id: string }>
    get: (id: string) => Promise<{
        status: () => Promise<{ status: string; output?: unknown; error?: unknown }>
    }>
}

export interface DurableObjectStubBinding {
    fetch: (request: Request | string, init?: RequestInit) => Promise<Response>
    reportProgress?: (event: DocumentProgressEvent) => Promise<void>
}

export interface DurableObjectNamespaceBinding {
    idFromName: (name: string) => unknown
    get: (id: unknown) => DurableObjectStubBinding
}

export interface AppEnv {
    AI?: WorkersAi
    DB?: D1DatabaseBinding
    FILES?: R2BucketBinding
    VECTORIZE?: VectorizeIndexBinding
    PDF_WORKFLOW?: WorkflowInstanceBinding
    YOUTUBE_WORKFLOW?: WorkflowInstanceBinding
    DOCUMENT_PROGRESS_DO?: DurableObjectNamespaceBinding
    ASSETS?: unknown
    IMAGES?: unknown
    APP_PIN?: string
    SUPADATA_API_KEY?: string
    SCRAPINGBEE_API_KEY?: string
    R2_BUCKET?: string
    R2_ACCESS_KEY_ID?: string
    R2_SECRET_ACCESS_KEY?: string
    R2_ENDPOINT?: string
    R2_PUBLIC_URL?: string
    CLOUDFLARE_ACCOUNT_ID?: string
    CLOUDFLARE_API_TOKEN?: string
    DISABLE_TRANSCRIPT_FALLBACK?: string
}

export * from "./youtube-types"
