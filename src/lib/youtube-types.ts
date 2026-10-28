/**
 * Canonical types for the YouTube video chat feature.
 */

export type YoutubeVideoStatus =
    | "queued"
    | "validating"
    | "extracting"
    | "awaiting_confirmation"
    | "chunking"
    | "embedding"
    | "indexing"
    | "ready"
    | "failed"

export type YoutubeVideoStage =
    | "validating"
    | "checking_cache"
    | "extracting"
    | "awaiting_confirmation"
    | "chunking"
    | "embedding"
    | "indexing"
    | "ready"
    | "failed"

export interface TranscriptSegment {
    id: string
    startSeconds: number
    endSeconds: number
    text: string
    lang?: string
}

export interface NormalizedTranscript {
    videoId: string
    lang: string
    source: "native" | "ai"
    provider?: "scrapingbee" | "supadata" | "supadata-ai"
    segments: TranscriptSegment[]
    fullText: string
    duration: number // total duration in seconds
    version: number
}

export interface YoutubeVideoItem {
    id: string // 11-char canonical YouTube ID
    title: string
    url: string
    channel_title?: string | null
    duration: number
    thumbnail_url?: string | null
    transcript_lang?: string | null
    transcript_source?: "native" | "ai" | null
    transcript_version: number
    status: YoutubeVideoStatus
    stage?: YoutubeVideoStage | null
    progress: number
    error_message?: string | null
    embedding_model: string
    chunk_count: number
    created_at: number
    updated_at: number
    completed_at?: number | null
}

export interface YoutubeChunk {
    id: string // ${videoId}_${chunkIndex}
    videoId: string
    chunkIndex: number
    startSeconds: number
    endSeconds: number
    text: string
}

export interface Citation {
    id: string // chunk ID or citation ID
    videoId: string
    startSeconds: number
    endSeconds: number
    text?: string
    quote?: string
}

export interface YoutubeDiagnosticEvent {
    event: string
    requestId: string
    provider: string
    failureCategory: string
    message: string
}

export interface YoutubeProgressEvent {
    videoId: string
    status: YoutubeVideoStatus
    stage: YoutubeVideoStage
    progress: number
    message?: string
    error?: string
    needsConfirmation?: boolean
    completedAt?: number
    timestamp: number
    chunksIndexed?: number
    totalChunks?: number
    diagnostic?: YoutubeDiagnosticEvent
}

export interface YoutubeInitRequest {
    url: string
    conversationId?: string | null
}

export interface YoutubeInitResponse {
    videoId: string
    url: string
    status: YoutubeVideoStatus
    stage: YoutubeVideoStage
    progress: number
    isReady: boolean
    video?: YoutubeVideoItem | null
    message?: string
    needsConfirmation?: boolean
}

export interface YoutubeConfirmationRequest {
    videoId: string
    confirmed: boolean
}

export interface YoutubeChatRequestBody {
    conversationId?: string
    videoId: string
    message: string
    effort?: "low" | "medium" | "high"
}
