"use client";

import React, { useState } from "react";
import { Message } from "@/lib/types";
import { MarkdownRenderer } from "./MarkdownRenderer";
import {
  BrainIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CopyIcon,
  FileTextIcon,
  ImageIcon,
  RefreshCwIcon,
  SparklesIcon,
} from "./Icons";

interface ChatMessageProps {
  message: Message;
  isStreaming?: boolean;
  onRegenerate?: () => void;
}

export function ChatMessage({ message, isStreaming = false, onRegenerate }: ChatMessageProps) {
  const isUser = message.role === "user";
  const [copied, setCopied] = useState(false);
  const [isThinkingOpen, setIsThinkingOpen] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(message.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (isUser) {
    return (
      <div className="flex justify-end mb-4 sm:mb-6">
        <div className="max-w-[90%] sm:max-w-2xl rounded-2xl px-3.5 py-2.5 sm:px-4 sm:py-3 bg-[var(--user-msg-bg)] text-[var(--text-primary)] border border-[var(--border)] shadow-xs">
          {/* Attachments preview */}
          {message.attachments && message.attachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5 sm:gap-2 mb-2 pb-2 border-b border-[var(--border)]/60">
              {message.attachments.map((att) => (
                <div
                  key={att.id}
                  className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs bg-[var(--surface-bg)] border border-[var(--border)] shadow-2xs"
                >
                  {att.isImage ? (
                    <ImageIcon size={13} className="text-emerald-500 shrink-0" />
                  ) : (
                    <FileTextIcon size={13} className="text-blue-500 shrink-0" />
                  )}
                  <span className="truncate max-w-[120px] sm:max-w-[150px] font-medium">{att.name}</span>
                </div>
              ))}
            </div>
          )}
          <p className="whitespace-pre-wrap text-sm leading-relaxed">{message.content}</p>
        </div>
      </div>
    );
  }

  // Assistant message
  return (
    <div className="flex gap-2.5 sm:gap-4 mb-6 sm:mb-8">
      {/* Avatar */}
      <div className="w-6 h-6 sm:w-7 sm:h-7 rounded-lg bg-[var(--accent)] text-white flex items-center justify-center shrink-0 text-[11px] sm:text-xs font-serif font-bold shadow-xs mt-0.5">
        C
      </div>

      <div className="flex-1 min-w-0">
        {/* Model & Effort header */}
        <div className="flex items-center gap-1.5 sm:gap-2 mb-1.5 sm:mb-2">
          <span className="text-xs font-semibold text-[var(--text-primary)] truncate max-w-[180px] sm:max-w-xs">
            {message.model ? message.model.split("/").pop() : "Claude AI"}
          </span>
          {message.effort && (
            <span className="text-[10px] font-mono uppercase px-1.5 py-0.2 rounded bg-[var(--badge-bg)] text-[var(--text-muted)] border border-[var(--border)]/60">
              {message.effort}
            </span>
          )}
        </div>

        {/* Collapsible Reasoning / Thinking Block */}
        {message.reasoning && (
          <div className="mb-3 rounded-xl border border-[var(--border)] bg-[var(--code-bg)] overflow-hidden text-xs">
            <button
              type="button"
              onClick={() => setIsThinkingOpen(!isThinkingOpen)}
              className="w-full flex items-center justify-between px-3 py-2 text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--button-hover)] transition-colors cursor-pointer"
            >
              <div className="flex items-center gap-1.5 sm:gap-2">
                <BrainIcon size={14} className="text-purple-500 shrink-0" />
                <span className="font-medium font-mono text-[11px]">
                  {isStreaming && !message.content ? "Thinking in progress..." : "Thought process"}
                </span>
              </div>
              {isThinkingOpen ? <ChevronDownIcon size={14} /> : <ChevronRightIcon size={14} />}
            </button>

            {isThinkingOpen && (
              <div className="p-3 sm:p-3.5 border-t border-[var(--border)] text-[var(--text-muted)] font-mono text-[11px] sm:text-[12px] leading-relaxed whitespace-pre-wrap bg-[var(--surface-bg)] max-h-72 overflow-y-auto">
                {message.reasoning}
              </div>
            )}
          </div>
        )}

        {/* Message Content */}
        <div className="text-sm leading-relaxed text-[var(--text-primary)] break-words">
          {message.content ? (
            <MarkdownRenderer content={message.content} />
          ) : isStreaming ? (
            <span className="inline-flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
              <span className="inline-block w-2 h-2 rounded-full bg-[var(--accent)] animate-ping" />
              Generating response...
            </span>
          ) : null}
        </div>

        {/* Action Toolbar */}
        {!isStreaming && message.content && (
          <div className="flex items-center gap-1.5 sm:gap-2 mt-2.5 sm:mt-3 pt-1">
            <button
              type="button"
              onClick={handleCopy}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--button-hover)] transition-colors cursor-pointer active:scale-95"
              title="Copy response"
            >
              {copied ? <CheckIcon size={13} className="text-emerald-500" /> : <CopyIcon size={13} />}
              <span>{copied ? "Copied" : "Copy"}</span>
            </button>

            {onRegenerate && (
              <button
                type="button"
                onClick={onRegenerate}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--button-hover)] transition-colors cursor-pointer active:scale-95"
                title="Regenerate response"
              >
                <RefreshCwIcon size={13} />
                <span>Regenerate</span>
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
