import { env } from "cloudflare:workers"
import { Attachment, EffortLevel } from "./types"
import { DEFAULT_MODEL_ID, getModel, TRANSCRIPTION_MODEL_ID } from "./models"

export class AiBindingError extends Error {
    constructor(message: string = "Workers AI binding (AI) is missing or unconfigured.") {
        super(message)
        this.name = "AiBindingError"
    }
}

export class R2BindingError extends Error {
    constructor(
        message: string = "R2 Bucket binding (FILES) is missing or unconfigured. Please replace REPLACE_WITH_R2_BUCKET_NAME in cloudflare.config.ts."
    ) {
        super(message)
        this.name = "R2BindingError"
    }
}

export function getAi(override?: any): any {
    const ai = override || (env as any)?.AI
    if (!ai || typeof ai.run !== "function") {
        throw new AiBindingError()
    }
    return ai
}

export function getR2(override?: any): any {
    const r2 = override || (env as any)?.FILES
    if (!r2 || typeof r2.get !== "function") {
        throw new R2BindingError()
    }
    return r2
}

export interface EffortConfig {
    temperature: number
    max_tokens: number
    systemInstruction: string
}

export function getEffortConfig(effort: EffortLevel = "medium"): EffortConfig {
    switch (effort) {
        case "low":
            return {
                temperature: 0.3,
                max_tokens: 1024,
                systemInstruction:
                    "Be direct, concise, and focused. Avoid unnecessary filler or preamble.",
            }
        case "high":
            return {
                temperature: 0.7,
                max_tokens: 4096,
                systemInstruction:
                    "Provide exhaustive, rigorous, and step-by-step reasoning. Analyze edge cases and explain complex nuances thoroughly.",
            }
        case "medium":
        default:
            return {
                temperature: 0.6,
                max_tokens: 2048,
                systemInstruction: "Provide clear, balanced, and helpful explanations.",
            }
    }
}

/**
 * Automatically submit required license agreement for gated models (e.g. Meta Llama 3.2 Vision)
 * Cloudflare error 5016 requires submitting the prompt 'agree' once per account.
 */
export async function acceptModelAgreement(modelId: string, aiOverride?: any): Promise<boolean> {
    const ai = getAi(aiOverride)
    try {
        await ai.run(modelId, { prompt: "agree" })
        console.log(`Accepted license agreement for model: ${modelId}`)
        return true
    } catch {
        try {
            await ai.run(modelId, { messages: [{ role: "user", content: "agree" }] })
            console.log(`Accepted license agreement for model via messages: ${modelId}`)
            return true
        } catch (err2: any) {
            console.warn(`Could not submit 'agree' to model ${modelId}:`, err2?.message || err2)
            return false
        }
    }
}

/**
 * Transcribe audio using Workers AI Whisper
 */
export async function transcribeAudio(
    audioBytes: ArrayBuffer | Uint8Array,
    aiOverride?: any
): Promise<string> {
    const ai = getAi(aiOverride)
    const uint8 = audioBytes instanceof Uint8Array ? audioBytes : new Uint8Array(audioBytes)
    if (uint8.byteLength < 500) {
        return ""
    }
    const audioArray = Array.from(uint8)

    try {
        const response = await ai.run(TRANSCRIPTION_MODEL_ID, {
            audio: audioArray,
        })
        return response?.text || ""
    } catch (err: any) {
        console.warn(
            "Primary Whisper transcription failed, attempting whisper-large-v3-turbo fallback:",
            err?.message
        )
        try {
            const response = await ai.run("@cf/openai/whisper-large-v3-turbo", {
                audio: audioArray,
            })
            return response?.text || ""
        } catch {
            throw err
        }
    }
}

/**
 * Stream a chat completion with Workers AI, parsing reasoning and normalizing SSE tokens.
 */
export async function* streamChat(
    modelId: string,
    messages: Array<{ role: string; content: string }>,
    options: {
        effort?: EffortLevel
        attachments?: Attachment[]
        systemPrompt?: string
        aiOverride?: any
        r2Override?: any
    } = {}
): AsyncGenerator<
    { delta?: string; reasoning?: string; isDone?: boolean },
    { fullContent: string; fullReasoning: string }
> {
    const ai = getAi(options.aiOverride)
    const model = getModel(modelId)
    const effort = options.effort || "medium"
    const effortConfig = getEffortConfig(effort)

    // Build the message list
    const fullMessages: Array<{ role: string; content: string }> = []

    // Add system prompt if present or default
    const systemDirectives = [effortConfig.systemInstruction]
    if (options.systemPrompt) {
        systemDirectives.push(options.systemPrompt)
    }

    fullMessages.push({
        role: "system",
        content: systemDirectives.join("\n\n"),
    })

    for (const m of messages) {
        fullMessages.push({
            role: m.role,
            content: m.content,
        })
    }

    const runOptions: Record<string, any> = {
        messages: fullMessages,
        stream: true,
        temperature: effortConfig.temperature,
        max_tokens: effortConfig.max_tokens,
    }

    // Pass reasoning_effort if supported
    if (model.supportsReasoning) {
        runOptions.reasoning_effort = effort
    }

    // Vision handling: if image attachments exist and model supports vision
    const imageAttachment = options.attachments?.find((a) => a.isImage)
    if (imageAttachment) {
        try {
            const r2 = getR2(options.r2Override)
            const r2Obj = await r2.get(imageAttachment.r2_key)
            if (r2Obj) {
                const imageBuf = await r2Obj.arrayBuffer()
                runOptions.image = Array.from(new Uint8Array(imageBuf))
            }
        } catch (err) {
            console.error("Failed to load image attachment from R2 for vision model:", err)
        }
    }

    // Call Workers AI with streaming enabled, with automatic 5016 license agreement retry
    let rawStream: any
    try {
        rawStream = await ai.run(model.id || DEFAULT_MODEL_ID, runOptions)
    } catch (err: any) {
        const errMsg = err?.message || String(err)
        if (
            errMsg.includes("5016") ||
            errMsg.includes("submit the prompt 'agree'") ||
            errMsg.includes("Community License")
        ) {
            console.log(
                `Model license agreement required (error 5016) for ${model.id}. Auto-submitting 'agree'...`
            )
            await acceptModelAgreement(model.id || DEFAULT_MODEL_ID, options.aiOverride)
            // Retry the user's inference call now that the agreement has been accepted
            rawStream = await ai.run(model.id || DEFAULT_MODEL_ID, runOptions)
        } else {
            throw err
        }
    }

    if (!rawStream || typeof rawStream.getReader !== "function") {
        // Non-streaming fallback if stream returned direct object
        const text =
            (rawStream as any)?.response || (rawStream as any)?.choices?.[0]?.message?.content || ""
        yield { delta: text }
        return { fullContent: text, fullReasoning: "" }
    }

    const reader = rawStream.getReader()
    const decoder = new TextDecoder()

    let fullContent = ""
    let fullReasoning = ""
    let buffer = ""
    let inThinkTag = false

    try {
        while (true) {
            const { done, value } = await reader.read()
            if (done) break

            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split("\n")
            buffer = lines.pop() || ""

            for (const line of lines) {
                const trimmed = line.trim()
                if (!trimmed || !trimmed.startsWith("data:")) continue

                const rawData = trimmed.replace(/^data:\s*/, "")
                if (rawData === "[DONE]") {
                    yield { isDone: true }
                    continue
                }

                try {
                    const parsed = JSON.parse(rawData)
                    // Extract text token from either { response: "..." } or OpenAI-style { choices: [ { delta: { content: "..." } } ] }
                    let token = ""
                    if (typeof parsed.response === "string") {
                        token = parsed.response
                    } else if (parsed.choices?.[0]?.delta?.content) {
                        token = parsed.choices[0].delta.content
                    } else if (typeof parsed.text === "string") {
                        token = parsed.text
                    }

                    if (!token) continue

                    // Parse and separate <think> tags for reasoning models
                    let remaining = token
                    while (remaining.length > 0) {
                        if (!inThinkTag) {
                            const thinkStart = remaining.indexOf("<think>")
                            if (thinkStart !== -1) {
                                const before = remaining.slice(0, thinkStart)
                                if (before) {
                                    fullContent += before
                                    yield { delta: before }
                                }
                                inThinkTag = true
                                remaining = remaining.slice(thinkStart + 7)
                            } else {
                                fullContent += remaining
                                yield { delta: remaining }
                                remaining = ""
                            }
                        } else {
                            const thinkEnd = remaining.indexOf("</think>")
                            if (thinkEnd !== -1) {
                                const thought = remaining.slice(0, thinkEnd)
                                if (thought) {
                                    fullReasoning += thought
                                    yield { reasoning: thought }
                                }
                                inThinkTag = false
                                remaining = remaining.slice(thinkEnd + 8)
                            } else {
                                fullReasoning += remaining
                                yield { reasoning: remaining }
                                remaining = ""
                            }
                        }
                    }
                } catch {
                    // Line wasn't valid JSON, continue
                }
            }
        }
    } finally {
        reader.releaseLock()
    }

    return { fullContent, fullReasoning }
}
