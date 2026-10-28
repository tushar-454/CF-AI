import type { ModelInfo } from "./types"

export const MODELS: ModelInfo[] = [
    // Fast / Small (Default)
    {
        id: "@cf/meta/llama-3.2-3b-instruct",
        label: "Llama 3.2 3B Instruct",
        category: "Fast/Small",
        description:
            "Ultra-fast, low latency Meta model with 128k context window. Ideal for quick queries and general assistance.",
        supportsStreaming: true,
        supportsVision: false,
        supportsReasoning: false,
        contextWindow: 131072,
    },
    {
        id: "@cf/meta/llama-3.2-1b-instruct",
        label: "Llama 3.2 1B Instruct",
        category: "Fast/Small",
        description:
            "Meta's most lightweight & lowest-latency LLM with 60k context window. Highest output capacity on the free tier.",
        supportsStreaming: true,
        supportsVision: false,
        supportsReasoning: false,
        contextWindow: 60000,
    },
    {
        id: "@cf/microsoft/phi-2",
        label: "Microsoft Phi-2 2.7B",
        category: "Fast/Small",
        description:
            "Compact 2.7B parameter model from Microsoft trained on high-quality synthetic data for logical and common-sense QA.",
        supportsStreaming: true,
        supportsVision: false,
        supportsReasoning: false,
        contextWindow: 2048,
    },
    {
        id: "@cf/tinyllama/tinyllama-1.1b-chat-v1.0",
        label: "TinyLlama 1.1B Chat",
        category: "Fast/Small",
        description:
            "Ultra-compact 1.1B open chat model designed for near-instant responses with negligible neuron usage.",
        supportsStreaming: true,
        supportsVision: false,
        supportsReasoning: false,
        contextWindow: 2048,
    },

    // General
    {
        id: "@cf/meta/llama-3.1-8b-instruct",
        label: "Llama 3.1 8B Instruct",
        category: "General",
        description:
            "Meta's flagship 8B model with 128k context window, advanced multilingual fluency, and strong instruction compliance.",
        supportsStreaming: true,
        supportsVision: false,
        supportsReasoning: false,
        contextWindow: 131072,
    },
    {
        id: "@cf/meta/llama-3-8b-instruct",
        label: "Llama 3 8B Instruct",
        category: "General",
        description:
            "Meta's widely-acclaimed 8B parameter model with proven dialogue quality, broad knowledge, and reasoning.",
        supportsStreaming: true,
        supportsVision: false,
        supportsReasoning: false,
        contextWindow: 8192,
    },
    {
        id: "@cf/mistral/mistral-7b-instruct-v0.1",
        label: "Mistral 7B Instruct",
        category: "General",
        description:
            "Mistral AI's high-efficiency 7.3B model featuring grouped-query attention for fast, natural conversation.",
        supportsStreaming: true,
        supportsVision: false,
        supportsReasoning: false,
        contextWindow: 8192,
    },
    {
        id: "@cf/google/gemma-7b-it",
        label: "Gemma 7B IT",
        category: "General",
        description:
            "Google's capable open-weight model built from the same research and technology used to create Gemini.",
        supportsStreaming: true,
        supportsVision: false,
        supportsReasoning: false,
        contextWindow: 8192,
    },
    {
        id: "@cf/openchat/openchat-3.5-0106",
        label: "OpenChat 3.5",
        category: "General",
        description:
            "Open-source fine-tuned conversational model optimized with C-RLFT for engaging dialogue and helpfulness.",
        supportsStreaming: true,
        supportsVision: false,
        supportsReasoning: false,
        contextWindow: 8192,
    },

    // Reasoning
    {
        id: "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
        label: "DeepSeek R1 Distill 32B",
        category: "Reasoning",
        description:
            "DeepSeek R1 reasoning distilled into Qwen 32B. Emits detailed <think> thought traces for complex math and logic.",
        supportsStreaming: true,
        supportsVision: false,
        supportsReasoning: true,
        contextWindow: 32768,
    },
    {
        id: "@cf/qwen/qwq-32b",
        label: "QwQ 32B Preview",
        category: "Reasoning",
        description:
            "Alibaba's reasoning model with step-by-step thinking for deep math, coding, and problem solving.",
        supportsStreaming: true,
        supportsVision: false,
        supportsReasoning: true,
        contextWindow: 32768,
    },
    {
        id: "@cf/openai/gpt-oss-20b",
        label: "GPT-OSS 20B",
        category: "Reasoning",
        description:
            "OpenAI open weights model designed for reasoning, agentic tasks, and software synthesis.",
        supportsStreaming: true,
        supportsVision: false,
        supportsReasoning: true,
        contextWindow: 32768,
    },

    // Coding
    {
        id: "@cf/qwen/qwen2.5-coder-32b-instruct",
        label: "Qwen 2.5 Coder 32B",
        category: "Coding",
        description:
            "Specialized code generation, debugging, refactoring, and multi-file software engineering model.",
        supportsStreaming: true,
        supportsVision: false,
        supportsReasoning: false,
        contextWindow: 32768,
    },

    // Vision
    {
        id: "@cf/meta/llama-3.2-11b-vision-instruct",
        label: "Llama 3.2 11B Vision",
        category: "Vision",
        description:
            "Meta's multimodal model for high-resolution image analysis, chart understanding, OCR, and visual Q&A.",
        supportsStreaming: true,
        supportsVision: true,
        supportsReasoning: false,
        contextWindow: 131072,
    },
]

export const DEFAULT_MODEL_ID = "@cf/meta/llama-3.2-3b-instruct"
export const EMBEDDING_MODEL_ID = "@cf/baai/bge-base-en-v1.5"
export const TRANSCRIPTION_MODEL_ID = "@cf/openai/whisper"

export function getModel(id: string): ModelInfo {
    const found = MODELS.find((m) => m.id === id)
    if (found) return found
    return (
        MODELS.find((m) => m.id === DEFAULT_MODEL_ID) || {
            id,
            label: id.split("/").pop() || id,
            category: "General",
            description: "Cloudflare Workers AI model",
            supportsStreaming: true,
            supportsVision: false,
            supportsReasoning: false,
            contextWindow: 8192,
        }
    )
}
