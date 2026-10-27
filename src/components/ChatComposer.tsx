"use client";

import React, { useRef, useEffect, useState } from "react";
import { Attachment, ContextMode, EffortLevel, ModelInfo } from "@/lib/types";
import { ModelSelector } from "./ModelSelector";
import { ContextSelector } from "./ContextSelector";
import { EffortSelector } from "./EffortSelector";
import { VoiceInput } from "./VoiceInput";
import { PaperclipIcon, SendIcon, StopIcon, XIcon, FileTextIcon, ImageIcon } from "./Icons";
import { getAuthHeaders } from "@/lib/auth";

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
    <div className="w-full max-w-3xl mx-auto px-4 pb-4">
      <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface-bg)] shadow-md transition-all focus-within:ring-2 focus-within:ring-[var(--accent)]/30 focus-within:border-[var(--accent)]">
        {/* Attachment chips */}
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 px-3 pt-3">
            {attachments.map((att) => (
              <div
                key={att.id}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs bg-[var(--badge-bg)] border border-[var(--border)] text-[var(--text-primary)]"
              >
                {att.isImage ? (
                  <ImageIcon size={13} className="text-emerald-500 shrink-0" />
                ) : (
                  <FileTextIcon size={13} className="text-blue-500 shrink-0" />
                )}
                <span className="truncate max-w-[140px] font-medium">{att.name}</span>
                <span className="text-[10px] text-[var(--text-muted)]">({(att.size / 1024).toFixed(0)}KB)</span>
                <button
                  type="button"
                  onClick={() => removeAttachment(att.id)}
                  className="p-0.5 rounded-full hover:bg-[var(--button-hover)] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
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
          placeholder="Reply to Claude or start a new task... (Shift+Enter for newline)"
          rows={1}
          className="w-full resize-none px-4 py-3 bg-transparent text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none scrollbar-none leading-relaxed"
        />

        {/* Bottom Toolbar */}
        <div className="flex flex-wrap items-center justify-between gap-2 px-3 pb-2.5 pt-1 border-t border-[var(--border)]/50">
          {/* Left Controls: Selectors & Attachments */}
          <div className="flex flex-wrap items-center gap-1.5">
            <ModelSelector
              models={models}
              selectedModelId={selectedModel}
              onSelectModel={onSelectModel}
              hasImageAttachment={hasImageAttachment}
            />

            <ContextSelector value={contextMode} onChange={onChangeContextMode} />

            <EffortSelector value={effort} onChange={onChangeEffort} />

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
              className={`p-1.5 rounded-lg text-xs font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--button-hover)] transition-colors ${
                isUploading ? "opacity-50 cursor-wait" : ""
              }`}
              title="Attach files or images"
              aria-label="Attach file"
            >
              <PaperclipIcon size={16} />
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
          <div>
            {isStreaming ? (
              <button
                type="button"
                onClick={onStopGeneration}
                className="inline-flex items-center justify-center p-2 rounded-xl bg-red-600 hover:bg-red-700 text-white shadow-xs transition-colors"
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
                className={`inline-flex items-center justify-center p-2 rounded-xl transition-all shadow-xs ${
                  input.trim() || attachments.length > 0
                    ? "bg-[var(--accent)] hover:opacity-90 text-white cursor-pointer"
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
      <div className="text-center mt-2 text-[11px] text-[var(--text-muted)]">
        Powered exclusively by Cloudflare Workers AI, D1, R2, and Vectorize.
      </div>
    </div>
  );
}
