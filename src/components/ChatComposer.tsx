"use client"

import { getAuthHeaders } from "@/lib/auth-client"
import { subscribeToDocumentProgress } from "@/lib/sse-client"
import { uploadFileDirect } from "@/lib/upload-client"
import { Attachment, ContextMode, DocumentItem, EffortLevel, ModelInfo } from "@/lib/types"
import React, { useEffect, useRef, useState } from "react"
import { ContextSelector } from "./ContextSelector"
import { EffortSelector } from "./EffortSelector"
import { BookOpenIcon, FileTextIcon, PaperclipIcon, SendIcon, StopIcon, XIcon } from "./Icons"
import { ModelSelector } from "./ModelSelector"
import { VoiceInput } from "./VoiceInput"

interface ChatComposerProps {
    models: ModelInfo[]
    selectedModel: string
    onSelectModel: (id: string) => void
    contextMode: ContextMode
    onChangeContextMode: (mode: ContextMode) => void
    effort: EffortLevel
    onChangeEffort: (effort: EffortLevel) => void
    onSendMessage: (message: string, attachments: Attachment[]) => void
    isStreaming: boolean
    onStopGeneration: () => void
    onNotification?: (msg: string, isError?: boolean) => void
    selectedDocIds?: string[]
    knowledgeDocs?: DocumentItem[]
    onToggleSelectDoc?: (id: string) => void
    onOpenKnowledgeBase?: () => void
}

export function ChatComposer({
    models,
    selectedModel,
    onSelectModel,
    contextMode,
    onChangeContextMode,
    effort,
    onChangeEffort,
    onSendMessage,
    isStreaming,
    onStopGeneration,
    onNotification,
    selectedDocIds = [],
    knowledgeDocs = [],
    onToggleSelectDoc,
    onOpenKnowledgeBase,
}: ChatComposerProps) {
    const [input, setInput] = useState("")
    const [attachments, setAttachments] = useState<Attachment[]>([])
    const [isUploading, setIsUploading] = useState(false)
    const textareaRef = useRef<HTMLTextAreaElement>(null)
    const fileInputRef = useRef<HTMLInputElement>(null)
    const subscriptionsRef = useRef<Map<string, () => void>>(new Map())

    // Auto-resize textarea
    useEffect(() => {
        if (textareaRef.current) {
            textareaRef.current.style.height = "auto"
            textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 220)}px`
        }
    }, [input])

    // Cleanup subscriptions on unmount
    useEffect(() => {
        const subs = subscriptionsRef.current
        return () => {
            for (const unsub of subs.values()) {
                unsub()
            }
            subs.clear()
        }
    }, [])

    const hasImageAttachment = attachments.some((a) => a.isImage)

    // If image attached and current model doesn't support vision, prompt user or auto-switch
    useEffect(() => {
        if (hasImageAttachment) {
            const current = models.find((m) => m.id === selectedModel)
            if (current && !current.supportsVision) {
                const visionModel = models.find((m) => m.supportsVision)
                if (visionModel) {
                    onSelectModel(visionModel.id)
                    onNotification?.(`Switched to ${visionModel.label} for image support.`)
                    // Proactively accept license agreement so subsequent requests succeed
                    fetch("/api/models/agree", {
                        method: "POST",
                        headers: getAuthHeaders({ "Content-Type": "application/json" }),
                        body: JSON.stringify({ model: visionModel.id }),
                    }).catch(() => {})
                }
            }
        }
    }, [hasImageAttachment, models, selectedModel, onSelectModel, onNotification])

    const handleSend = () => {
        if (isStreaming) {
            onStopGeneration()
            return
        }

        // Prevent sending while any attached PDF is still being indexed in Workflow
        const isIndexing = attachments.some(
            (a) => a.status === "queued" || a.status === "processing"
        )
        if (isIndexing) {
            onNotification?.(
                "Please wait for PDF processing and indexing to complete before sending.",
                true
            )
            return
        }

        const trimmed = input.trim()
        if (!trimmed && attachments.length === 0) return

        onSendMessage(trimmed || "(attached file)", attachments)
        setInput("")
        setAttachments([])
        if (textareaRef.current) {
            textareaRef.current.style.height = "auto"
        }
    }

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault()
            handleSend()
        }
    }

    const handleFileUpload = async (files: FileList | null) => {
        if (!files || files.length === 0) return
        setIsUploading(true)

        for (let i = 0; i < files.length; i++) {
            const file = files[i]

            try {
                const result = await uploadFileDirect(file)
                const doc = result.document

                const data: Attachment = {
                    id: doc.id,
                    name: doc.name,
                    mime: doc.mime,
                    size: doc.size,
                    r2_key: doc.r2_key,
                    isImage: doc.status === "image",
                    isPdf: result.isPdf,
                    status: doc.status,
                    stage: doc.stage,
                    progress: doc.progress,
                    url: `/api/files/${doc.id}`,
                }

                if (data.isPdf && (data.status === "queued" || data.status === "processing")) {
                    setAttachments((prev) => [
                        ...prev,
                        { ...data, status: "queued", stage: "upload", progress: 0 },
                    ])
                    onNotification?.(`"${file.name}" uploaded. Cloudflare Workflow processing...`)

                    const unsub = subscribeToDocumentProgress(data.id, {
                        onProgress: (evt) => {
                            setAttachments((prev) =>
                                prev.map((a) =>
                                    a.id === evt.documentId
                                        ? {
                                              ...a,
                                              status: evt.status,
                                              stage: evt.stage,
                                              progress: evt.progress,
                                          }
                                        : a
                                )
                            )
                        },
                        onReady: (evt) => {
                            setAttachments((prev) =>
                                prev.map((a) =>
                                    a.id === evt.documentId
                                        ? {
                                              ...a,
                                              status: "ready",
                                              stage: "ready",
                                              progress: 100,
                                          }
                                        : a
                                )
                            )
                            onToggleSelectDoc?.(evt.documentId)
                            onNotification?.(`"${file.name}" indexed and ready.`)
                            subscriptionsRef.current.get(data.id)?.()
                            subscriptionsRef.current.delete(data.id)
                        },
                        onFailed: (evt) => {
                            setAttachments((prev) =>
                                prev.map((a) =>
                                    a.id === evt.documentId
                                        ? { ...a, status: "failed", stage: "failed" }
                                        : a
                                )
                            )
                            onNotification?.(
                                `Indexing failed for "${file.name}": ${evt.error || "Unknown error"}`,
                                true
                            )
                            subscriptionsRef.current.get(data.id)?.()
                            subscriptionsRef.current.delete(data.id)
                        },
                    })
                    subscriptionsRef.current.set(data.id, unsub)
                } else {
                    setAttachments((prev) => [...prev, data])
                    onNotification?.(`Attached "${file.name}".`)
                }
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : "File upload failed"
                onNotification?.(msg, true)
            }
        }

        setIsUploading(false)
    }

    const removeAttachment = (id: string) => {
        const unsub = subscriptionsRef.current.get(id)
        if (unsub) {
            unsub()
            subscriptionsRef.current.delete(id)
        }
        setAttachments((prev) => prev.filter((a) => a.id !== id))
    }

    return (
        <div className="w-full max-w-3xl mx-auto px-2.5 sm:px-4 pb-2 sm:pb-4 relative z-10">
            <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface-bg)] shadow-md transition-all focus-within:ring-2 focus-within:ring-[var(--accent)]/30 focus-within:border-[var(--accent)] relative">
                {/* Attachment chips */}
                {attachments.length > 0 && (
                    <div className="flex flex-wrap gap-2 px-3 pt-3">
                        {attachments.map((att) => {
                            const isProcessing =
                                att.status === "queued" || att.status === "processing"
                            const isFailed = att.status === "failed"

                            return (
                                <div
                                    key={att.id}
                                    className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs border shadow-2xs ${
                                        isProcessing
                                            ? "bg-amber-500/10 border-amber-500/30 text-amber-700 dark:text-amber-300"
                                            : isFailed
                                              ? "bg-red-500/10 border-red-500/30 text-red-600 dark:text-red-400"
                                              : "bg-[var(--badge-bg)] border-[var(--border)] text-[var(--text-primary)]"
                                    }`}
                                >
                                    {isProcessing ? (
                                        <div
                                            className="w-3.5 h-3.5 rounded-full border-2 border-[var(--border)] border-t-[var(--accent)] animate-spin shrink-0"
                                            title="Processing via Cloudflare Workflow..."
                                        />
                                    ) : isFailed ? (
                                        <span className="text-red-500 font-bold shrink-0 text-xs">
                                            !
                                        </span>
                                    ) : att.isImage ? (
                                        <div className="w-5 h-5 rounded overflow-hidden bg-[var(--surface-bg)] shrink-0 border border-[var(--border)]/50">
                                            <img
                                                src={att.url || `/api/files/${att.id}`}
                                                alt={att.name}
                                                className="w-full h-full object-cover"
                                            />
                                        </div>
                                    ) : (
                                        <FileTextIcon
                                            size={13}
                                            className="text-blue-500 shrink-0"
                                        />
                                    )}
                                    <span className="truncate max-w-[130px] sm:max-w-[160px] font-medium">
                                        {att.name}
                                    </span>
                                    {isProcessing ? (
                                        <span className="text-[10px] font-semibold text-amber-600 dark:text-amber-400">
                                            ({att.progress ?? 0}%)
                                        </span>
                                    ) : isFailed ? (
                                        <span className="text-[10px] text-red-500 font-semibold">
                                            (Failed)
                                        </span>
                                    ) : (
                                        <span className="text-[10px] text-[var(--text-muted)]">
                                            ({(att.size / 1024).toFixed(0)}KB)
                                        </span>
                                    )}
                                    <button
                                        type="button"
                                        onClick={() => removeAttachment(att.id)}
                                        className="p-0.5 rounded-full hover:bg-[var(--button-hover)] text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer"
                                        aria-label="Remove attachment"
                                    >
                                        <XIcon size={12} />
                                    </button>
                                </div>
                            )
                        })}
                    </div>
                )}

                {/* Active Knowledge Base Document Chips for current chat */}
                {selectedDocIds.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5 px-3 pt-2.5">
                        <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-amber-600 dark:text-amber-400 shrink-0">
                            <BookOpenIcon size={12} />
                            <span>Active RAG:</span>
                        </span>
                        {selectedDocIds.map((id) => {
                            const doc = knowledgeDocs.find((d) => d.id === id)
                            const isPdf =
                                doc?.mime === "application/pdf" ||
                                doc?.name.toLowerCase().endsWith(".pdf")
                            return (
                                <div
                                    key={id}
                                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg text-xs bg-amber-500/10 border border-amber-500/25 text-amber-700 dark:text-amber-300 shadow-2xs font-medium"
                                >
                                    <span className="truncate max-w-[130px] sm:max-w-[170px]">
                                        {doc?.name || "Document"}
                                    </span>
                                    {isPdf && (
                                        <span className="text-[9px] font-mono font-bold text-red-500">
                                            PDF
                                        </span>
                                    )}
                                    {onToggleSelectDoc && (
                                        <button
                                            type="button"
                                            onClick={() => onToggleSelectDoc(id)}
                                            className="p-0.5 rounded-full hover:bg-amber-500/20 text-amber-600 dark:text-amber-400 cursor-pointer"
                                            title="Unselect document for this chat"
                                        >
                                            <XIcon size={11} />
                                        </button>
                                    )}
                                </div>
                            )
                        })}
                        {onOpenKnowledgeBase && (
                            <button
                                type="button"
                                onClick={onOpenKnowledgeBase}
                                className="text-[11px] font-medium text-[var(--accent)] hover:underline cursor-pointer ml-1"
                            >
                                + Change
                            </button>
                        )}
                    </div>
                )}

                {/* Text Area */}
                <textarea
                    ref={textareaRef}
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="Ask Claude anything... (Shift+Enter for newline)"
                    rows={1}
                    className="w-full resize-none px-3.5 pt-3 pb-2 sm:px-4 sm:pt-3.5 bg-transparent text-base sm:text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none scrollbar-none leading-relaxed"
                />

                {/* Selectors Pill Strip (Horizontally Scrollable on mobile, overflow-visible on desktop) */}
                <div className="flex items-center gap-1.5 overflow-x-auto sm:overflow-visible scrollbar-none px-2.5 sm:px-3 py-1.5 border-t border-[var(--border)]/40 bg-[var(--surface-bg)] relative z-20">
                    <ModelSelector
                        models={models}
                        selectedModelId={selectedModel}
                        onSelectModel={onSelectModel}
                        hasImageAttachment={hasImageAttachment}
                    />

                    <EffortSelector value={effort} onChange={onChangeEffort} />

                    <ContextSelector value={contextMode} onChange={onChangeContextMode} />

                    {onOpenKnowledgeBase && (
                        <button
                            type="button"
                            onClick={onOpenKnowledgeBase}
                            className={`inline-flex items-center gap-1 sm:gap-1.5 px-2 sm:px-2.5 py-1.5 rounded-xl text-xs font-medium border transition-colors cursor-pointer shrink-0 ${
                                selectedDocIds.length > 0
                                    ? "bg-amber-500/15 border-amber-500/40 text-amber-700 dark:text-amber-300 shadow-2xs font-semibold"
                                    : "border-[var(--border)] bg-[var(--surface-bg)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--button-hover)]"
                            }`}
                            title="Select Knowledge Base documents for this chat"
                        >
                            <BookOpenIcon
                                size={13}
                                className={
                                    selectedDocIds.length > 0 ? "text-amber-500" : "opacity-70"
                                }
                            />
                            <span>Knowledge</span>
                            <span
                                className={`text-[10px] font-mono px-1.5 py-0.2 rounded-full ${
                                    selectedDocIds.length > 0
                                        ? "bg-amber-500/20 text-amber-700 dark:text-amber-300 font-bold"
                                        : "bg-[var(--badge-bg)] text-[var(--text-muted)]"
                                }`}
                            >
                                {selectedDocIds.length}
                            </span>
                        </button>
                    )}
                </div>

                {/* Bottom Actions Bar */}
                <div className="flex items-center justify-between gap-2 px-2.5 sm:px-3 pb-2 pt-1 border-t border-[var(--border)]/30">
                    {/* Left Media Actions */}
                    <div className="flex items-center gap-1">
                        {/* Hidden File Input */}
                        <input
                            type="file"
                            ref={fileInputRef}
                            multiple
                            className="hidden"
                            onChange={(e) => handleFileUpload(e.target.files)}
                        />

                        {/* Attach Button */}
                        <button
                            type="button"
                            onClick={() => fileInputRef.current?.click()}
                            disabled={isUploading}
                            className={`p-2 rounded-xl text-xs font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--button-hover)] transition-colors cursor-pointer shrink-0 active:scale-95 ${
                                isUploading ? "opacity-50 cursor-wait" : ""
                            }`}
                            title="Attach files or images"
                            aria-label="Attach file"
                        >
                            <PaperclipIcon size={17} />
                        </button>

                        {/* Voice Typing Button */}
                        <VoiceInput
                            onTranscript={(text) => {
                                setInput((prev) => (prev ? `${prev} ${text}` : text))
                            }}
                            onError={(err) => onNotification?.(err, true)}
                        />
                    </div>

                    {/* Right Action: Send / Stop Button */}
                    <div className="shrink-0">
                        {isStreaming ? (
                            <button
                                type="button"
                                onClick={onStopGeneration}
                                className="inline-flex items-center justify-center w-8 h-8 sm:w-9 sm:h-9 rounded-xl bg-red-600 hover:bg-red-700 text-white shadow-xs transition-transform active:scale-95 cursor-pointer"
                                title="Stop generation"
                                aria-label="Stop generation"
                            >
                                <StopIcon size={16} />
                            </button>
                        ) : (
                            <button
                                type="button"
                                onClick={handleSend}
                                disabled={!input.trim() && attachments.length === 0}
                                className={`inline-flex items-center justify-center w-8 h-8 sm:w-9 sm:h-9 rounded-xl transition-all shadow-xs active:scale-95 ${
                                    input.trim() || attachments.length > 0
                                        ? "bg-[var(--accent)] hover:opacity-95 text-white cursor-pointer"
                                        : "bg-[var(--button-hover)] text-[var(--text-muted)] opacity-50 cursor-not-allowed"
                                }`}
                                title="Send message (Enter)"
                                aria-label="Send message"
                            >
                                <SendIcon size={16} />
                            </button>
                        )}
                    </div>
                </div>
            </div>
            <div className="text-center mt-1.5 text-[10px] sm:text-[11px] text-[var(--text-muted)] px-2 truncate">
                Powered by Cloudflare Workers AI, D1, R2, and Vectorize
            </div>
        </div>
    )
}
