"use client";

import React, { useState, useEffect, useRef } from "react";
import { DocumentItem } from "@/lib/types";
import { AlertCircleIcon, BookOpenIcon, CheckIcon, FileTextIcon, ImageIcon, PaperclipIcon, TrashIcon, XIcon } from "./Icons";
import { getAuthHeaders } from "@/lib/auth";

interface KnowledgeBaseModalProps {
  isOpen: boolean;
  onClose: () => void;
  onNotification?: (msg: string, isError?: boolean) => void;
}

export function KnowledgeBaseModal({ isOpen, onClose, onNotification }: KnowledgeBaseModalProps) {
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadDocuments = async () => {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const res = await fetch("/api/files", { headers: getAuthHeaders() });
      if (!res.ok) {
        const data: any = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to load documents");
      }
      const data: any = await res.json();
      setDocuments(Array.isArray(data) ? data : []);
    } catch (err: any) {
      setErrorMessage(err?.message || "Could not connect to database");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      loadDocuments();
    }
  }, [isOpen]);

  const handleFileUpload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setIsUploading(true);
    setErrorMessage(null);

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const formData = new FormData();
      formData.append("file", file);

      try {
        const res = await fetch("/api/upload", {
          method: "POST",
          headers: getAuthHeaders(),
          body: formData,
        });

        if (!res.ok) {
          const errData: any = await res.json().catch(() => ({}));
          throw new Error(errData.error || `Upload failed for ${file.name}`);
        }

        onNotification?.(`Indexed "${file.name}" to Knowledge Base.`);
      } catch (err: any) {
        setErrorMessage(err?.message || "Upload failed");
        onNotification?.(err?.message || "Upload failed", true);
      }
    }

    setIsUploading(false);
    loadDocuments();
  };

  const handleDelete = async (docId: string, docName: string) => {
    if (!confirm(`Delete "${docName}" from knowledge base?`)) return;

    try {
      const res = await fetch(`/api/files/${docId}`, {
        method: "DELETE",
        headers: getAuthHeaders(),
      });
      if (!res.ok) {
        const data: any = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to delete document");
      }
      setDocuments((prev) => prev.filter((d) => d.id !== docId));
      onNotification?.(`Deleted "${docName}".`);
    } catch (err: any) {
      onNotification?.(err?.message || "Failed to delete document", true);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-2.5 sm:p-4 bg-black/50 backdrop-blur-xs animate-in fade-in duration-150">
      <div className="w-full max-w-2xl rounded-2xl border border-[var(--border)] bg-[var(--surface-bg)] shadow-2xl overflow-hidden flex flex-col max-h-[90vh] sm:max-h-[85vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 sm:px-6 sm:py-4 border-b border-[var(--border)] bg-[var(--sidebar-bg)]">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="p-2 rounded-xl bg-amber-500/10 text-[var(--accent)] shrink-0">
              <BookOpenIcon size={20} />
            </div>
            <div className="min-w-0">
              <h2 className="text-sm sm:text-base font-semibold text-[var(--text-primary)] truncate">Knowledge Base Documents</h2>
              <p className="text-[11px] sm:text-xs text-[var(--text-muted)] truncate">RAG Vectorize semantic storage & R2 file store</p>
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

        {/* Upload Zone */}
        <div className="p-4 sm:p-6 border-b border-[var(--border)]">
          <div
            onClick={() => fileInputRef.current?.click()}
            className="border-2 border-dashed border-[var(--border)] hover:border-[var(--accent)] rounded-xl p-4 sm:p-6 text-center cursor-pointer transition-colors bg-[var(--sidebar-bg)] hover:bg-[var(--selected-bg)]"
          >
            <input
              type="file"
              ref={fileInputRef}
              multiple
              className="hidden"
              onChange={(e) => handleFileUpload(e.target.files)}
            />
            <PaperclipIcon size={24} className="mx-auto text-[var(--accent)] mb-2" />
            <p className="text-sm font-medium text-[var(--text-primary)]">
              {isUploading ? "Uploading & Vectorizing document..." : "Click or drag files to add to Knowledge Base"}
            </p>
            <p className="text-xs text-[var(--text-muted)] mt-1">
              Supports Markdown, TXT, Code, PDF-text, JSON, CSV (Max 10 MB). Automatically chunked & embedded into Vectorize.
            </p>
          </div>

          {errorMessage && (
            <div className="mt-3 p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-xs text-red-600 dark:text-red-400 flex items-center gap-2">
              <AlertCircleIcon size={16} className="shrink-0" />
              <span>{errorMessage}</span>
            </div>
          )}
        </div>

        {/* Document List */}
        <div className="flex-1 overflow-y-auto p-6 space-y-2">
          <div className="flex items-center justify-between text-xs font-semibold text-[var(--text-muted)] px-3 pb-2 uppercase tracking-wider">
            <span>Documents ({documents.length})</span>
            <span>Status</span>
          </div>

          {isLoading ? (
            <div className="text-center py-12 text-xs text-[var(--text-muted)]">Loading documents...</div>
          ) : documents.length === 0 ? (
            <div className="text-center py-12 text-sm text-[var(--text-muted)]">
              No documents uploaded yet. Upload reference material to query with the "Knowledge base" context mode.
            </div>
          ) : (
            documents.map((doc) => (
              <div
                key={doc.id}
                className="flex items-center justify-between p-3 rounded-xl border border-[var(--border)] bg-[var(--surface-bg)] hover:bg-[var(--sidebar-bg)] transition-colors text-sm"
              >
                <div className="flex items-center gap-3 min-w-0 pr-4">
                  {doc.mime.startsWith("image/") ? (
                    <ImageIcon size={18} className="text-emerald-500 shrink-0" />
                  ) : (
                    <FileTextIcon size={18} className="text-blue-500 shrink-0" />
                  )}
                  <div className="min-w-0">
                    <p className="font-medium text-[var(--text-primary)] truncate">{doc.name}</p>
                    <p className="text-xs text-[var(--text-muted)]">
                      {(doc.size / 1024).toFixed(1)} KB • {new Date(doc.created_at).toLocaleDateString()}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-3 shrink-0">
                  <span
                    className={`text-[11px] font-mono px-2 py-0.5 rounded-full capitalize ${
                      doc.status === "ready"
                        ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20"
                        : doc.status === "image"
                        ? "bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20"
                        : "bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20"
                    }`}
                  >
                    {doc.status === "ready" ? "Indexed (Vectorize)" : doc.status}
                  </span>

                  <button
                    type="button"
                    onClick={() => handleDelete(doc.id, doc.name)}
                    className="p-1.5 rounded-lg text-[var(--text-muted)] hover:text-red-500 hover:bg-red-500/10 transition-colors"
                    title="Delete document"
                  >
                    <TrashIcon size={16} />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-[var(--border)] bg-[var(--sidebar-bg)] flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-xl text-xs font-medium bg-[var(--surface-bg)] border border-[var(--border)] hover:bg-[var(--button-hover)] text-[var(--text-primary)] transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
