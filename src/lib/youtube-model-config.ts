/**
 * Dedicated, strongly typed model configuration for YouTube video chat.
 * Centralizes all model choices, reasoning defaults, generation hyperparameters,
 * RAG retrieval budgets, and chunking limits in file-level constants.
 */

export const YOUTUBE_CHAT_CONFIG = {
    // Primary reasoning model: DeepSeek R1 Distill Qwen 32B on Cloudflare Workers AI
    modelId: "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b" as const,

    // Fallback general instruct model if primary model experiences capacity throttling
    fallbackModelId: "@cf/meta/llama-3.1-8b-instruct" as const,

    // Vector embedding model (768 dimensions, cosine metric) matching chatbot-rag-index
    embeddingModelId: "@cf/baai/bge-base-en-v1.5" as const,
    embeddingDimensions: 768,

    // Generation parameters
    defaultEffort: "medium" as const,
    temperature: 0.6,
    maxTokens: 4096,

    // RAG and Chunking limits
    retrievalTopK: 8,
    maxContextChunks: 6,
    chunkSize: 800, // characters per chunk
    chunkOverlap: 100, // overlap characters
    maxContextCharBudget: 16000,

    // Transcript provider: ScrapingBee Subtitles API configuration
    scrapingbeeBaseUrl: "https://app.scrapingbee.com/api/v1/youtube/subtitles",

    // Supadata API configuration (legacy/fallback reference)
    supadataBaseUrl: "https://api.supadata.ai/v1",
    pollIntervalMs: 2500,
    maxPollRetries: 40,
    requestTimeoutMs: 35000,

    // Cloudflare Workflow configuration
    workflowMaxRetries: 3,
    workflowRetryDelaySeconds: 2,
} as const

export const YOUTUBE_EMBEDDING_CONFIG = {
    modelId: YOUTUBE_CHAT_CONFIG.embeddingModelId,
    dimensions: YOUTUBE_CHAT_CONFIG.embeddingDimensions,
} as const

export type YoutubeChatConfig = typeof YOUTUBE_CHAT_CONFIG
export type YoutubeEmbeddingConfig = typeof YOUTUBE_EMBEDDING_CONFIG
