"use client"

import React, { useState, useEffect, useRef, useCallback } from "react"
import { DocumentItem } from "@/lib/types"
import {
    AlertCircleIcon,
    BookOpenIcon,
    CheckIcon,
    FileTextIcon,
    GlobeIcon,
    ImageIcon,
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
    selectedDocIds: string[]
    onToggleSelectDoc: (id: string) => void
    onSelectAllDocs: (ids: string[]) => void
    onClearSelectedDocs: () => void
    onDocumentsLoaded?: (docs: DocumentItem[]) => void
}

export function KnowledgeBaseModal({
    isOpen,
    onClose,
    onNotification,
    selectedDocIds,
    onToggleSelectDoc,
    onSelectAllDocs,
    onClearSelectedDocs,
    onDocumentsLoaded,
}: KnowledgeBaseModalProps) {
    const [documents, setDocuments] = useState<DocumentItem[]>([])
    const [isLoading, setIsLoading] = useState(false)
    const [isUploading, setIsUploading] = useState(false)
    const [errorMessage, setErrorMessage] = useState<string | null>(null)

    const fileInputRef = useRef<HTMLInputElement>(null)
    const selectAllRef = useRef<HTMLInputElement>(null)

    const loadDocuments = useCallback(async () => {
        setIsLoading(true)
        setErrorMessage(null)
        try {
            const res = await fetch("/api/files", { headers: getAuthHeaders() })
            if (!res.ok) {
                const data = (await res.json().catch(() => ({}))) as { error?: string }
                throw new Error(data.error || "Failed to load documents")
            }
            const data = (await res.json()) as DocumentItem[]
            const docList = Array.isArray(data) ? data : []
            setDocuments(docList)
            onDocumentsLoaded?.(docList)
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : "Could not connect to database"
            setErrorMessage(msg)
        } finally {
            setIsLoading(false)
        }
    }, [onDocumentsLoaded])

    useEffect(() => {
        if (isOpen) {
            loadDocuments()
        }
    }, [isOpen, loadDocuments])

    const totalCount = documents.length
    const selectedInDocs = documents.filter((d) => selectedDocIds.includes(d.id))
    const selectedCount = selectedInDocs.length
    const isAllSelected = totalCount > 0 && selectedCount === totalCount
    const isSomeSelected = selectedCount > 0 && selectedCount < totalCount

    useEffect(() => {
        if (selectAllRef.current) {
            selectAllRef.current.indeterminate = isSomeSelected
        }
    }, [isSomeSelected])

    const handleToggleSelectAll = () => {
        if (isAllSelected) {
            onClearSelectedDocs()
        } else {
            onSelectAllDocs(documents.map((d) => d.id))
        }
    }

    // Single document delete from Global Knowledge Base
    const handleDelete = async (docId: string, docName: string) => {
        if (!confirm(`Delete "${docName}" permanently from Global Knowledge Base?`)) return

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
            if (selectedDocIds.includes(docId)) {
                onToggleSelectDoc(docId)
            }
            onNotification?.(`Deleted "${docName}".`)
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : "Failed to delete document"
            onNotification?.(msg, true)
        }
    }

    // Handle file upload into Global Knowledge Base
    const handleFileUpload = async (files: FileList | null) => {
        if (!files || files.length === 0) return
        setIsUploading(true)
        setErrorMessage(null)

        for (let i = 0; i < files.length; i++) {
            const file = files[i]
            const formData = new FormData()
            formData.append("file", file)

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

                const data = (await res.json()) as { id?: string }
                // Automatically select newly uploaded document for this chat session
                if (data?.id) {
                    onToggleSelectDoc(data.id)
                }
                onNotification?.(
                    `Indexed "${file.name}" to Global Knowledge Base and selected for this chat.`
                )
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
                                    Global Knowledge Base
                                </h2>
                                <span className="hidden xs:inline-flex text-[10px] font-semibold px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20">
                                    Vectorize RAG
                                </span>
                            </div>
                            <p className="text-[11px] sm:text-xs text-[var(--text-muted)] truncate">
                                All documents are stored globally • Check the PDFs you want active
                                for this chat
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

                {/* Important Selection Notice Banner */}
                <div className="px-4 py-2.5 sm:px-6 border-b border-[var(--border)] bg-amber-500/5 text-xs text-[var(--text-muted)] flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                        <GlobeIcon size={14} className="text-amber-500 shrink-0" />
                        <span className="truncate">
                            <strong className="text-[var(--text-primary)] font-medium">
                                Active Chat Filter:
                            </strong>{" "}
                            By default, no PDFs are selected. Only checked documents are used for
                            vector search.
                        </span>
                    </div>
                    {selectedCount > 0 ? (
                        <span className="shrink-0 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30">
                            {selectedCount} Selected
                        </span>
                    ) : (
                        <span className="shrink-0 text-[10px] font-mono px-2 py-0.5 rounded-full bg-[var(--badge-bg)] text-[var(--text-muted)] border border-[var(--border)]">
                            0 Selected
                        </span>
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
                                ? "Uploading, Extracting & Vectorizing document..."
                                : "Click or drag files to add to Global Knowledge Base"}
                        </p>
                        <p className="text-[11px] sm:text-xs text-[var(--text-muted)] mt-1">
                            Supports PDF (text extraction & vectorizing), Markdown, TXT, Code, JSON,
                            CSV (Max 10 MB).
                        </p>
                    </div>

                    {errorMessage && (
                        <div className="mt-3 p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-xs text-red-600 dark:text-red-400 flex items-center gap-2">
                            <AlertCircleIcon size={16} className="shrink-0" />
                            <span>{errorMessage}</span>
                        </div>
                    )}
                </div>

                {/* Document List Header & Checkbox Controls */}
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
                                disabled={totalCount === 0}
                                className="w-4 h-4 rounded border-[var(--border)] text-emerald-600 focus:ring-emerald-500 cursor-pointer accent-emerald-600"
                                aria-label="Select all documents for current chat"
                            />
                            <span className="truncate">
                                {selectedCount > 0
                                    ? `${selectedCount} of ${totalCount} active in this chat`
                                    : `Select all for this chat (${totalCount})`}
                            </span>
                        </label>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                        {selectedCount > 0 && (
                            <button
                                type="button"
                                id="clear-selected-kb-btn"
                                onClick={onClearSelectedDocs}
                                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--button-hover)] transition-all cursor-pointer border border-[var(--border)]"
                                title="Unselect all documents for this chat"
                            >
                                <XIcon size={12} />
                                <span>Unselect All</span>
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
                            <span>Loading knowledge base...</span>
                        </div>
                    ) : totalCount === 0 ? (
                        <div className="text-center py-12 px-4 rounded-xl border border-dashed border-[var(--border)] bg-[var(--sidebar-bg)]/50">
                            <div className="w-10 h-10 rounded-2xl bg-[var(--surface-bg)] text-[var(--text-muted)] border border-[var(--border)] flex items-center justify-center mx-auto mb-3 shadow-xs">
                                <GlobeIcon size={20} className="text-blue-500" />
                            </div>
                            <p className="text-xs sm:text-sm font-medium text-[var(--text-primary)] mb-1">
                                No documents in Global Knowledge Base
                            </p>
                            <p className="text-[11px] sm:text-xs text-[var(--text-muted)] max-w-sm mx-auto mb-4">
                                Upload PDFs or text reference files above. Once uploaded, you can
                                select which ones to use for any chat conversation.
                            </p>
                            <button
                                type="button"
                                onClick={() => fileInputRef.current?.click()}
                                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium bg-[var(--surface-bg)] border border-[var(--border)] hover:bg-[var(--button-hover)] text-[var(--text-primary)] transition-all cursor-pointer shadow-xs active:scale-95"
                            >
                                <PaperclipIcon size={14} className="text-[var(--accent)]" />
                                <span>Upload first document</span>
                            </button>
                        </div>
                    ) : (
                        documents.map((doc) => {
                            const isChecked = selectedDocIds.includes(doc.id)
                            const isPdf =
                                doc.mime === "application/pdf" ||
                                doc.name.toLowerCase().endsWith(".pdf")

                            return (
                                <div
                                    key={doc.id}
                                    onClick={() => onToggleSelectDoc(doc.id)}
                                    className={`group flex items-center justify-between p-3 rounded-xl border transition-all text-sm cursor-pointer select-none ${
                                        isChecked
                                            ? "border-emerald-500/40 bg-emerald-500/5 shadow-xs"
                                            : "border-[var(--border)] bg-[var(--surface-bg)] hover:bg-[var(--sidebar-bg)]"
                                    }`}
                                >
                                    {/* Left: Checkbox + Icon + Details */}
                                    <div className="flex items-center gap-3 min-w-0 pr-3">
                                        <input
                                            type="checkbox"
                                            id={`doc-checkbox-${doc.id}`}
                                            checked={isChecked}
                                            onChange={() => onToggleSelectDoc(doc.id)}
                                            onClick={(e) => e.stopPropagation()}
                                            className="w-4 h-4 rounded border-[var(--border)] text-emerald-600 focus:ring-emerald-500 cursor-pointer accent-emerald-600 shrink-0"
                                            aria-label={`Select ${doc.name} for current chat`}
                                        />

                                        <div className="shrink-0 p-1.5 rounded-lg bg-[var(--badge-bg)] text-[var(--text-muted)]">
                                            {isPdf ? (
                                                <div className="flex items-center gap-0.5 text-red-500 font-bold text-[9px]">
                                                    <FileTextIcon size={16} />
                                                </div>
                                            ) : doc.mime.startsWith("image/") ? (
                                                <ImageIcon size={16} className="text-emerald-500" />
                                            ) : (
                                                <FileTextIcon size={16} className="text-blue-500" />
                                            )}
                                        </div>

                                        <div className="min-w-0">
                                            <div className="flex items-center gap-1.5">
                                                <p className="font-medium text-[var(--text-primary)] truncate text-xs sm:text-sm">
                                                    {doc.name}
                                                </p>
                                                {isPdf && (
                                                    <span className="text-[9px] font-mono px-1 py-0.2 rounded bg-red-500/10 text-red-500 border border-red-500/20 shrink-0">
                                                        PDF
                                                    </span>
                                                )}
                                            </div>
                                            <div className="flex items-center gap-2 text-[10px] sm:text-xs text-[var(--text-muted)] mt-0.5">
                                                <span>{(doc.size / 1024).toFixed(1)} KB</span>
                                                <span>•</span>
                                                <span>
                                                    {new Date(doc.created_at).toLocaleDateString()}
                                                </span>
                                            </div>
                                        </div>
                                    </div>

                                    {/* Right: Active in Chat status & Delete button */}
                                    <div className="flex items-center gap-2.5 shrink-0">
                                        {isChecked ? (
                                            <span className="inline-flex items-center gap-1 text-[10px] sm:text-[11px] font-semibold px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30">
                                                <CheckIcon size={11} />
                                                <span>Active in Chat</span>
                                            </span>
                                        ) : (
                                            <span className="text-[10px] sm:text-[11px] font-medium px-2 py-0.5 rounded-full bg-[var(--badge-bg)] text-[var(--text-muted)] border border-[var(--border)]">
                                                Unselected
                                            </span>
                                        )}

                                        <button
                                            type="button"
                                            onClick={(e) => {
                                                e.stopPropagation()
                                                handleDelete(doc.id, doc.name)
                                            }}
                                            className="p-1.5 rounded-lg text-[var(--text-muted)] hover:text-red-500 hover:bg-red-500/10 transition-colors cursor-pointer"
                                            title={`Delete "${doc.name}" from Global Knowledge Base`}
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
                        {selectedCount === 0
                            ? "No documents selected (pure conversation mode)"
                            : `${selectedCount} document${selectedCount > 1 ? "s" : ""} active for this chat conversation`}
                    </span>
                    <button
                        type="button"
                        onClick={onClose}
                        className="px-4 py-2 rounded-xl text-xs font-semibold bg-[var(--accent)] hover:opacity-90 text-white transition-all cursor-pointer shadow-xs active:scale-95"
                    >
                        Done
                    </button>
                </div>
            </div>
        </div>
    )
}
