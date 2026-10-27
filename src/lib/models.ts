import { ModelInfo } from "./types";

export const MODELS: ModelInfo[] = [
  // Fast / Small (Default)
  {
    id: "@cf/meta/llama-3.2-3b-instruct",
    label: "Llama 3.2 3B Instruct",
    category: "Fast/Small",
    description: "Ultra-fast, low latency Meta model with 128k context window. Ideal for quick queries and general assistance.",
    supportsStreaming: true,
    supportsVision: false,
    supportsReasoning: false,
    contextWindow: 131072,
  },
  // General
  {
    id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    label: "Llama 3.3 70B Instruct Fast",
    category: "General",
    description: "Meta's flagship 70B parameter model with FP8 optimization. Strong reasoning, general knowledge, and instruction following.",
    supportsStreaming: true,
    supportsVision: false,
    supportsReasoning: false,
    contextWindow: 131072,
  },
  {
    id: "@cf/google/gemma-7b-it",
    label: "Gemma 7B IT",
    category: "General",
    description: "Google's lightweight, capable open model trained on Gemini technology.",
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
    description: "DeepSeek R1 reasoning distilled into Qwen 32B. Emits detailed <think> thought traces for complex math and logic.",
    supportsStreaming: true,
    supportsVision: false,
    supportsReasoning: true,
    contextWindow: 32768,
  },
  {
    id: "@cf/qwen/qwq-32b",
    label: "QwQ 32B Preview",
    category: "Reasoning",
    description: "Alibaba's reasoning model with step-by-step thinking for deep math, coding, and problem solving.",
    supportsStreaming: true,
    supportsVision: false,
    supportsReasoning: true,
    contextWindow: 32768,
  },
  {
    id: "@cf/openai/gpt-oss-20b",
    label: "GPT-OSS 20B",
    category: "Reasoning",
    description: "OpenAI open weights model designed for reasoning, agentic tasks, and software synthesis.",
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
    description: "Specialized code generation, debugging, refactoring, and multi-file software engineering model.",
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
    description: "Meta's multimodal model for high-resolution image analysis, chart understanding, OCR, and visual Q&A.",
    supportsStreaming: true,
    supportsVision: true,
    supportsReasoning: false,
    contextWindow: 131072,
  },
];

export const DEFAULT_MODEL_ID = "@cf/meta/llama-3.2-3b-instruct";
export const EMBEDDING_MODEL_ID = "@cf/baai/bge-base-en-v1.5";
export const TRANSCRIPTION_MODEL_ID = "@cf/openai/whisper";

export function getModel(id: string): ModelInfo {
  const found = MODELS.find((m) => m.id === id);
  if (found) return found;
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
  );
}
