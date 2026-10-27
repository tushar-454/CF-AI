"use client";

import React, { useRef, useEffect, useState } from "react";
import { Attachment, ContextMode, EffortLevel, ModelInfo } from "@/lib/types";
import { ModelSelector } from "./ModelSelector";
import { ContextSelector } from "./ContextSelector";
import { EffortSelector } from "./EffortSelector";
import { VoiceInput } from "./VoiceInput";
import { PaperclipIcon, SendIcon, StopIcon, XIcon, FileTextIcon, ImageIcon } from "./Icons";
import { getAuthHeaders } from "@/lib/auth-client";

interface ChatComposerProps {
  models: ModelInfo[];
  selectedModel: string;
  onSelectModel: (id: string) => void;
  contextMode: ContextMode;
  onChangeContextMode: (mode: ContextMode) => void;
  effort: EffortLevel;
  onChangeEffort: (effort: EffortLevel) => void;
  onSendMessage: (message: string, attachments: Attachment[]) => void;
  isStreaming: boolean;
  onStopGeneration: () => void;
  onNotification?: (msg: string, isError?: boolean) => void;
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
}: ChatComposerProps) {
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 220)}px`;
    }
  }, [input]);

  const hasImageAttachment = attachments.some((a) => a.isImage);

  // If image attached and current model doesn't support vision, prompt user or auto-switch
  useEffect(() => {
    if (hasImageAttachment) {
      const current = models.find((m) => m.id === selectedModel);
      if (current && !current.supportsVision) {
        const visionModel = models.find((m) => m.supportsVision);
        if (visionModel) {
          onSelectModel(visionModel.id);
          onNotification?.(`Switched to ${visionModel.label} for image support.`);
          // Proactively accept license agreement so subsequent requests succeed
          fetch("/api/models/agree", {
            method: "POST",
            headers: getAuthHeaders({ "Content-Type": "application/json" }),
            body: JSON.stringify({ model: visionModel.id }),
          }).catch(() => {});
        }
      }
    }
  }, [hasImageAttachment, models, selectedModel, onSelectModel, onNotification]);

  const handleSend = () => {
    if (isStreaming) {
      onStopGeneration();
      return;
    }
    const trimmed = input.trim();
    if (!trimmed && attachments.length === 0) return;

    onSendMessage(trimmed || "(attached file)", attachments);
    setInput("");
    setAttachments([]);
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleFileUpload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setIsUploading(true);

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

        const data: Attachment = await res.json();
        setAttachments((prev) => [...prev, data]);
        onNotification?.(`Attached "${file.name}".`);
      } catch (err: any) {
        onNotification?.(err?.message || "File upload failed", true);
      }
    }

    setIsUploading(false);
  };

  const removeAttachment = (id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  };

  return (
    <div className="w-full max-w-3xl mx-auto px-2.5 sm:px-4 pb-2 sm:pb-4">
      <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface-bg)] shadow-md transition-all focus-within:ring-2 focus-within:ring-[var(--accent)]/30 focus-within:border-[var(--accent)] overflow-hidden">
        {/* Attachment chips */}
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 px-3 pt-3">
            {attachments.map((att) => (
              <div
                key={att.id}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs bg-[var(--badge-bg)] border border-[var(--border)] text-[var(--text-primary)] shadow-2xs"
              >
                {att.isImage ? (
                  <ImageIcon size={13} className="text-emerald-500 shrink-0" />
                ) : (
                  <FileTextIcon size={13} className="text-blue-500 shrink-0" />
                )}
                <span className="truncate max-w-[130px] sm:max-w-[160px] font-medium">{att.name}</span>
                <span className="text-[10px] text-[var(--text-muted)]">({(att.size / 1024).toFixed(0)}KB)</span>
                <button
                  type="button"
                  onClick={() => removeAttachment(att.id)}
                  className="p-0.5 rounded-full hover:bg-[var(--button-hover)] text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer"
                  aria-label="Remove attachment"
                >
                  <XIcon size={12} />
                </button>
              </div>
            ))}
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

        {/* Selectors Pill Strip (Horizontally Scrollable without wrap breaks) */}
        <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-none px-2.5 sm:px-3 py-1.5 border-t border-[var(--border)]/40 bg-[var(--surface-bg)]">
          <ModelSelector
            models={models}
            selectedModelId={selectedModel}
            onSelectModel={onSelectModel}
            hasImageAttachment={hasImageAttachment}
          />

          <EffortSelector value={effort} onChange={onChangeEffort} />

          <ContextSelector value={contextMode} onChange={onChangeContextMode} />
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
                setInput((prev) => (prev ? `${prev} ${text}` : text));
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
  );
}
