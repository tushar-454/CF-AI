"use client"

import React, { useState, useEffect, useRef } from "react"
import { DocumentItem } from "@/lib/types"
import {
    AlertCircleIcon,
    BookOpenIcon,
    FileTextIcon,
    GlobeIcon,
    ImageIcon,
    MessageSquareIcon,
    PaperclipIcon,
    RefreshCwIcon,
    TrashIcon,
    XIcon,
} from "./Icons"
import { getAuthHeaders } from "@/lib/auth-client"

interface KnowledgeBaseModalProps {
    isOpen: boolean
    onClose: () => void
    onNotification?: (msg: string, isError?: boolean) => void
    activeConversationId?: string
    activeConversationTitle?: string
}

type ScopeTab = "chat" | "global"

export function KnowledgeBaseModal({
    isOpen,
    onClose,
    onNotification,
    activeConversationId,
    activeConversationTitle,
}: KnowledgeBaseModalProps) {
    const [documents, setDocuments] = useState<DocumentItem[]>([])
    const [isLoading, setIsLoading] = useState(false)
    const [isUploading, setIsUploading] = useState(false)
    const [isDeleting, setIsDeleting] = useState(false)
    const [errorMessage, setErrorMessage] = useState<string | null>(null)
    const [activeTab, setActiveTab] = useState<ScopeTab>(activeConversationId ? "chat" : "global")
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

    const fileInputRef = useRef<HTMLInputElement>(null)
    const selectAllRef = useRef<HTMLInputElement>(null)

    // Reset default active tab when activeConversationId changes or modal opens
    useEffect(() => {
        if (isOpen) {
            setActiveTab(activeConversationId ? "chat" : "global")
            setSelectedIds(new Set())
            loadDocuments()
        }
    }, [isOpen, activeConversationId])

    const loadDocuments = async () => {
        setIsLoading(true)
        setErrorMessage(null)
        try {
            const res = await fetch("/api/files", { headers: getAuthHeaders() })
            if (!res.ok) {
                const data = (await res.json().catch(() => ({}))) as { error?: string }
                throw new Error(data.error || "Failed to load documents")
            }
            const data = (await res.json()) as DocumentItem[]
            setDocuments(Array.isArray(data) ? data : [])
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : "Could not connect to database"
            setErrorMessage(msg)
        } finally {
            setIsLoading(false)
        }
    }

    // Partition documents by scope
    const chatDocs = documents.filter(
        (d) => d.conversation_id && d.conversation_id === activeConversationId
    )
    const globalDocs = documents.filter((d) => !d.conversation_id)

    // Current documents based on active tab
    const currentDocs = activeTab === "chat" && activeConversationId ? chatDocs : globalDocs

    // Selection metrics for the current tab
    const selectedInCurrent = currentDocs.filter((d) => selectedIds.has(d.id))
    const totalCount = currentDocs.length
    const selectedCount = selectedInCurrent.length
    const isAllSelected = totalCount > 0 && selectedCount === totalCount
    const isSomeSelected = selectedCount > 0 && selectedCount < totalCount
    const isIndeterminate = isSomeSelected

    // Manage indeterminate state on Select All checkbox
    useEffect(() => {
        if (selectAllRef.current) {
            selectAllRef.current.indeterminate = isIndeterminate
        }
    }, [isIndeterminate])

    // Toggle Select All for current tab
    const handleToggleSelectAll = () => {
        if (isAllSelected) {
            // Deselect all items in current view
            setSelectedIds((prev) => {
                const next = new Set(prev)
                currentDocs.forEach((doc) => next.delete(doc.id))
                return next
            })
        } else {
            // Select all items in current view
            setSelectedIds((prev) => {
                const next = new Set(prev)
                currentDocs.forEach((doc) => next.add(doc.id))
                return next
            })
        }
    }

    // Toggle single item selection
    const handleToggleItem = (id: string) => {
        setSelectedIds((prev) => {
            const next = new Set(prev)
            if (next.has(id)) {
                next.delete(id)
            } else {
                next.add(id)
            }
            return next
        })
    }

    // Bulk delete selected documents
    const handleDeleteSelected = async () => {
        const idsToDelete = selectedInCurrent.map((d) => d.id)
        if (idsToDelete.length === 0) return

        const scopeLabel = activeTab === "chat" && activeConversationId ? "this chat's" : "global"

        if (
            !confirm(
                `Delete ${idsToDelete.length} selected document(s) from ${scopeLabel} knowledge base?`
            )
        ) {
            return
        }

        setIsDeleting(true)
        try {
            const res = await fetch("/api/files", {
                method: "DELETE",
                headers: {
                    ...getAuthHeaders(),
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({ ids: idsToDelete }),
            })

            if (!res.ok) {
                const data = (await res.json().catch(() => ({}))) as { error?: string }
                throw new Error(data.error || "Failed to delete selected documents")
            }

            setDocuments((prev) => prev.filter((d) => !idsToDelete.includes(d.id)))
            setSelectedIds((prev) => {
                const next = new Set(prev)
                idsToDelete.forEach((id) => next.delete(id))
                return next
            })
            onNotification?.(
                `Deleted ${idsToDelete.length} document${idsToDelete.length > 1 ? "s" : ""}.`
            )
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : "Failed to delete selected documents"
            onNotification?.(msg, true)
        } finally {
            setIsDeleting(false)
        }
    }

    // Single document delete
    const handleDelete = async (docId: string, docName: string) => {
        if (!confirm(`Delete "${docName}" from knowledge base?`)) return

        try {
            const res = await fetch(`/api/files/${docId}`, {
                method: "DELETE",
                headers: getAuthHeaders(),
            })
            if (!res.ok) {
                const data = (await res.json().catch(() => ({}))) as { error?: string }
                throw new Error(data.error || "Failed to delete document")
            }
            setDocuments((prev) => prev.filter((d) => d.id !== docId))
            setSelectedIds((prev) => {
                const next = new Set(prev)
                next.delete(docId)
                return next
            })
            onNotification?.(`Deleted "${docName}".`)
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : "Failed to delete document"
            onNotification?.(msg, true)
        }
    }

    // Handle file upload based on active scope
    const handleFileUpload = async (files: FileList | null) => {
        if (!files || files.length === 0) return
        setIsUploading(true)
        setErrorMessage(null)

        const targetConversationId =
            activeTab === "chat" && activeConversationId ? activeConversationId : null

        for (let i = 0; i < files.length; i++) {
            const file = files[i]
            const formData = new FormData()
            formData.append("file", file)
            if (targetConversationId) {
                formData.append("conversationId", targetConversationId)
            }

            try {
                const res = await fetch("/api/upload", {
                    method: "POST",
                    headers: getAuthHeaders(),
                    body: formData,
                })

                if (!res.ok) {
                    const errData = (await res.json().catch(() => ({}))) as { error?: string }
                    throw new Error(errData.error || `Upload failed for ${file.name}`)
                }

                const scopeMsg = targetConversationId ? "this chat's" : "Global"
                onNotification?.(`Indexed "${file.name}" to ${scopeMsg} Knowledge Base.`)
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : "Upload failed"
                setErrorMessage(msg)
                onNotification?.(msg, true)
            }
        }

        setIsUploading(false)
        loadDocuments()
    }

    if (!isOpen) return null

    const hasActiveChat = Boolean(activeConversationId)

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-2.5 sm:p-4 bg-black/50 backdrop-blur-xs animate-in fade-in duration-150">
            <div className="w-full max-w-2xl rounded-2xl border border-[var(--border)] bg-[var(--surface-bg)] shadow-2xl overflow-hidden flex flex-col max-h-[92vh] sm:max-h-[88vh]">
                {/* Header */}
                <div className="flex items-center justify-between px-4 py-3 sm:px-6 sm:py-4 border-b border-[var(--border)] bg-[var(--sidebar-bg)]">
                    <div className="flex items-center gap-2.5 min-w-0">
                        <div className="p-2 rounded-xl bg-amber-500/10 text-[var(--accent)] shrink-0">
                            <BookOpenIcon size={20} />
                        </div>
                        <div className="min-w-0">
                            <div className="flex items-center gap-2">
                                <h2 className="text-sm sm:text-base font-semibold text-[var(--text-primary)] truncate">
                                    Knowledge Base Documents
                                </h2>
                                <span
                                    className={`hidden xs:inline-flex text-[10px] font-medium px-2 py-0.5 rounded-full ${
                                        hasActiveChat
                                            ? "bg-[var(--accent)]/10 text-[var(--accent)] border border-[var(--accent)]/20"
                                            : "bg-[var(--badge-bg)] text-[var(--text-muted)] border border-[var(--border)]"
                                    }`}
                                >
                                    {hasActiveChat ? "Session & Global" : "Global Mode"}
                                </span>
                            </div>
                            <p className="text-[11px] sm:text-xs text-[var(--text-muted)] truncate">
                                {hasActiveChat
                                    ? `Attached to "${activeConversationTitle || "active chat"}" or global storage`
                                    : "Global knowledge base • shared across all sessions"}
                            </p>
                        </div>
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        className="p-1.5 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--button-hover)] transition-colors cursor-pointer shrink-0"
                        aria-label="Close"
                    >
                        <XIcon size={18} />
                    </button>
                </div>

                {/* Scope Tabs (if in active chat) or Global Indicator (if no chat) */}
                <div className="px-4 py-2.5 sm:px-6 border-b border-[var(--border)] bg-[var(--surface-bg)]">
                    {hasActiveChat ? (
                        <div className="flex items-center gap-1.5 p-1 rounded-xl bg-[var(--sidebar-bg)] border border-[var(--border)] text-xs">
                            <button
                                type="button"
                                id="tab-kb-chat"
                                onClick={() => setActiveTab("chat")}
                                className={`flex-1 flex items-center justify-center gap-2 py-1.5 px-3 rounded-lg font-medium transition-all cursor-pointer ${
                                    activeTab === "chat"
                                        ? "bg-[var(--surface-bg)] text-[var(--text-primary)] shadow-xs border border-[var(--border)]"
                                        : "text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                                }`}
                            >
                                <MessageSquareIcon size={14} className="text-[var(--accent)]" />
                                <span className="truncate">This Chat</span>
                                <span
                                    className={`text-[10px] font-mono px-1.5 py-0.2 rounded-full ${
                                        activeTab === "chat"
                                            ? "bg-[var(--accent)]/15 text-[var(--accent)] font-semibold"
                                            : "bg-[var(--badge-bg)] text-[var(--text-muted)]"
                                    }`}
                                >
                                    {chatDocs.length}
                                </span>
                            </button>

                            <button
                                type="button"
                                id="tab-kb-global"
                                onClick={() => setActiveTab("global")}
                                className={`flex-1 flex items-center justify-center gap-2 py-1.5 px-3 rounded-lg font-medium transition-all cursor-pointer ${
                                    activeTab === "global"
                                        ? "bg-[var(--surface-bg)] text-[var(--text-primary)] shadow-xs border border-[var(--border)]"
                                        : "text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                                }`}
                            >
                                <GlobeIcon size={14} className="text-blue-500" />
                                <span className="truncate">Global Knowledge</span>
                                <span
                                    className={`text-[10px] font-mono px-1.5 py-0.2 rounded-full ${
                                        activeTab === "global"
                                            ? "bg-blue-500/15 text-blue-600 dark:text-blue-400 font-semibold"
                                            : "bg-[var(--badge-bg)] text-[var(--text-muted)]"
                                    }`}
                                >
                                    {globalDocs.length}
                                </span>
                            </button>
                        </div>
                    ) : (
                        <div className="flex items-center justify-between py-1 text-xs text-[var(--text-muted)]">
                            <div className="flex items-center gap-2">
                                <GlobeIcon size={15} className="text-blue-500 shrink-0" />
                                <span className="font-medium text-[var(--text-primary)]">
                                    Global Knowledge Base
                                </span>
                                <span className="text-[10px] font-mono px-1.5 py-0.2 rounded-full bg-[var(--badge-bg)] text-[var(--text-muted)]">
                                    {globalDocs.length} document{globalDocs.length !== 1 ? "s" : ""}
                                </span>
                            </div>
                            <span className="text-[11px] hidden sm:inline">
                                Open any chat to upload chat-specific docs
                            </span>
                        </div>
                    )}
                </div>

                {/* Upload Zone */}
                <div className="p-4 sm:p-5 border-b border-[var(--border)] bg-[var(--surface-bg)]">
                    <div
                        onClick={() => fileInputRef.current?.click()}
                        className="border-2 border-dashed border-[var(--border)] hover:border-[var(--accent)] rounded-xl p-3.5 sm:p-5 text-center cursor-pointer transition-all bg-[var(--sidebar-bg)] hover:bg-[var(--selected-bg)] group"
                    >
                        <input
                            type="file"
                            ref={fileInputRef}
                            multiple
                            className="hidden"
                            onChange={(e) => handleFileUpload(e.target.files)}
                        />
                        <PaperclipIcon
                            size={22}
                            className="mx-auto text-[var(--accent)] mb-1.5 group-hover:scale-110 transition-transform"
                        />
                        <p className="text-xs sm:text-sm font-semibold text-[var(--text-primary)]">
                            {isUploading
                                ? "Uploading & Vectorizing document..."
                                : activeTab === "chat" && activeConversationId
                                  ? "Click or drag files to add to THIS CHAT'S Knowledge Base"
                                  : "Click or drag files to add to GLOBAL Knowledge Base"}
                        </p>
                        <p className="text-[11px] sm:text-xs text-[var(--text-muted)] mt-1">
                            {activeTab === "chat" && activeConversationId
                                ? `Specific to "${activeConversationTitle || "current chat"}". Vectorize RAG semantic indexing.`
                                : "Available across all chats. Supports Markdown, TXT, Code, PDF, JSON, CSV (Max 10 MB)."}
                        </p>
                    </div>

                    {errorMessage && (
                        <div className="mt-3 p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-xs text-red-600 dark:text-red-400 flex items-center gap-2">
                            <AlertCircleIcon size={16} className="shrink-0" />
                            <span>{errorMessage}</span>
                        </div>
                    )}
                </div>

                {/* Document List Header & Bulk Selection Toolbar */}
                <div className="px-4 py-2.5 sm:px-6 border-b border-[var(--border)] bg-[var(--sidebar-bg)] flex items-center justify-between text-xs">
                    <div className="flex items-center gap-2.5 min-w-0">
                        <label
                            htmlFor="select-all-kb-checkbox"
                            className="flex items-center gap-2 cursor-pointer select-none font-medium text-[var(--text-primary)]"
                        >
                            <input
                                id="select-all-kb-checkbox"
                                ref={selectAllRef}
                                type="checkbox"
                                checked={isAllSelected}
                                onChange={handleToggleSelectAll}
                                disabled={currentDocs.length === 0}
                                className="w-4 h-4 rounded border-[var(--border)] text-[var(--accent)] focus:ring-[var(--accent)] cursor-pointer accent-[var(--accent)]"
                                aria-label="Select all documents"
                            />
                            <span className="truncate">
                                {selectedCount > 0
                                    ? `${selectedCount} of ${totalCount} selected`
                                    : `Select all (${totalCount})`}
                            </span>
                        </label>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                        {selectedCount > 0 && (
                            <button
                                type="button"
                                id="delete-selected-kb-btn"
                                onClick={handleDeleteSelected}
                                disabled={isDeleting}
                                className="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-semibold bg-red-500/10 hover:bg-red-500/20 text-red-600 dark:text-red-400 border border-red-500/30 transition-all cursor-pointer active:scale-95 shadow-xs"
                                title="Delete selected documents"
                            >
                                <TrashIcon size={13} />
                                <span>
                                    {isDeleting ? "Deleting..." : `Delete (${selectedCount})`}
                                </span>
                            </button>
                        )}

                        <button
                            type="button"
                            onClick={loadDocuments}
                            className="p-1 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--button-hover)] transition-colors cursor-pointer"
                            title="Refresh document list"
                            aria-label="Refresh document list"
                        >
                            <RefreshCwIcon size={14} className={isLoading ? "animate-spin" : ""} />
                        </button>
                    </div>
                </div>

                {/* Document List */}
                <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-2 custom-scrollbar">
                    {isLoading ? (
                        <div className="text-center py-12 text-xs text-[var(--text-muted)] flex flex-col items-center justify-center gap-2">
                            <div className="w-6 h-6 rounded-full border-2 border-[var(--border)] border-t-[var(--accent)] animate-spin" />
                            <span>Loading documents...</span>
                        </div>
                    ) : currentDocs.length === 0 ? (
                        <div className="text-center py-12 px-4 rounded-xl border border-dashed border-[var(--border)] bg-[var(--sidebar-bg)]/50">
                            <div className="w-10 h-10 rounded-2xl bg-[var(--surface-bg)] text-[var(--text-muted)] border border-[var(--border)] flex items-center justify-center mx-auto mb-3 shadow-xs">
                                {activeTab === "chat" ? (
                                    <MessageSquareIcon size={20} className="text-[var(--accent)]" />
                                ) : (
                                    <GlobeIcon size={20} className="text-blue-500" />
                                )}
                            </div>
                            <p className="text-xs sm:text-sm font-medium text-[var(--text-primary)] mb-1">
                                {activeTab === "chat"
                                    ? "No chat-specific documents uploaded"
                                    : "No global documents uploaded"}
                            </p>
                            <p className="text-[11px] sm:text-xs text-[var(--text-muted)] max-w-sm mx-auto mb-4">
                                {activeTab === "chat"
                                    ? "Upload documents directly above to give this session tailored reference context for RAG queries."
                                    : "Upload reference files that should be accessible across every conversation in the app."}
                            </p>
                            <button
                                type="button"
                                onClick={() => fileInputRef.current?.click()}
                                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium bg-[var(--surface-bg)] border border-[var(--border)] hover:bg-[var(--button-hover)] text-[var(--text-primary)] transition-all cursor-pointer shadow-xs active:scale-95"
                            >
                                <PaperclipIcon size={14} className="text-[var(--accent)]" />
                                <span>Upload files now</span>
                            </button>
                        </div>
                    ) : (
                        currentDocs.map((doc) => {
                            const isChecked = selectedIds.has(doc.id)
                            return (
                                <div
                                    key={doc.id}
                                    onClick={() => handleToggleItem(doc.id)}
                                    className={`group flex items-center justify-between p-3 rounded-xl border transition-all text-sm cursor-pointer select-none ${
                                        isChecked
                                            ? "border-[var(--accent)]/40 bg-[var(--selected-bg)] shadow-xs"
                                            : "border-[var(--border)] bg-[var(--surface-bg)] hover:bg-[var(--sidebar-bg)]"
                                    }`}
                                >
                                    {/* Left: Checkbox + Icon + Details */}
                                    <div className="flex items-center gap-3 min-w-0 pr-3">
                                        <input
                                            type="checkbox"
                                            id={`doc-checkbox-${doc.id}`}
                                            checked={isChecked}
                                            onChange={() => handleToggleItem(doc.id)}
                                            onClick={(e) => e.stopPropagation()}
                                            className="w-4 h-4 rounded border-[var(--border)] text-[var(--accent)] focus:ring-[var(--accent)] cursor-pointer accent-[var(--accent)] shrink-0"
                                            aria-label={`Select ${doc.name}`}
                                        />

                                        <div className="shrink-0 p-1.5 rounded-lg bg-[var(--badge-bg)] text-[var(--text-muted)]">
                                            {doc.mime.startsWith("image/") ? (
                                                <ImageIcon size={16} className="text-emerald-500" />
                                            ) : (
                                                <FileTextIcon size={16} className="text-blue-500" />
                                            )}
                                        </div>

                                        <div className="min-w-0">
                                            <p className="font-medium text-[var(--text-primary)] truncate text-xs sm:text-sm">
                                                {doc.name}
                                            </p>
                                            <div className="flex items-center gap-2 text-[10px] sm:text-xs text-[var(--text-muted)] mt-0.5">
                                                <span>{(doc.size / 1024).toFixed(1)} KB</span>
                                                <span>•</span>
                                                <span>
                                                    {new Date(doc.created_at).toLocaleDateString()}
                                                </span>
                                                {doc.conversation_id ? (
                                                    <span className="hidden sm:inline-block text-[10px] font-medium px-1.5 py-0.2 rounded bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20">
                                                        This Chat
                                                    </span>
                                                ) : (
                                                    <span className="hidden sm:inline-block text-[10px] font-medium px-1.5 py-0.2 rounded bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20">
                                                        Global
                                                    </span>
                                                )}
                                            </div>
                                        </div>
                                    </div>

                                    {/* Right: Status badge & Delete button */}
                                    <div className="flex items-center gap-2.5 shrink-0">
                                        <span
                                            className={`text-[10px] sm:text-[11px] font-mono px-2 py-0.5 rounded-full capitalize ${
                                                doc.status === "ready"
                                                    ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20"
                                                    : doc.status === "image"
                                                      ? "bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20"
                                                      : "bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20"
                                            }`}
                                        >
                                            {doc.status === "ready"
                                                ? "Indexed (Vectorize)"
                                                : doc.status}
                                        </span>

                                        <button
                                            type="button"
                                            onClick={(e) => {
                                                e.stopPropagation()
                                                handleDelete(doc.id, doc.name)
                                            }}
                                            className="p-1.5 rounded-lg text-[var(--text-muted)] hover:text-red-500 hover:bg-red-500/10 transition-colors cursor-pointer"
                                            title={`Delete "${doc.name}"`}
                                            aria-label={`Delete ${doc.name}`}
                                        >
                                            <TrashIcon size={15} />
                                        </button>
                                    </div>
                                </div>
                            )
                        })
                    )}
                </div>

                {/* Footer */}
                <div className="px-4 py-3 sm:px-6 border-t border-[var(--border)] bg-[var(--sidebar-bg)] flex items-center justify-between text-xs">
                    <span className="text-[11px] text-[var(--text-muted)] truncate pr-2">
                        {currentDocs.length} file{currentDocs.length !== 1 ? "s" : ""} in{" "}
                        {activeTab === "chat" ? "chat scope" : "global scope"}
                    </span>
                    <button
                        type="button"
                        onClick={onClose}
                        className="px-4 py-2 rounded-xl text-xs font-medium bg-[var(--surface-bg)] border border-[var(--border)] hover:bg-[var(--button-hover)] text-[var(--text-primary)] transition-all cursor-pointer shadow-xs active:scale-95"
                    >
                        Close
                    </button>
                </div>
            </div>
        </div>
    )
}
