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

export interface AppEnv {
    AI?: any
    DB?: any
    FILES?: any
    VECTORIZE?: any
    ASSETS?: any
    IMAGES?: any
}
