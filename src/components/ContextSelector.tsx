"use client";

import React, { useState, useRef, useEffect } from "react";
import { ContextMode } from "@/lib/types";
import { BookOpenIcon, ChevronDownIcon, FileTextIcon, SparklesIcon, XIcon } from "./Icons";

interface ContextSelectorProps {
  value: ContextMode;
  onChange: (mode: ContextMode) => void;
}

const CONTEXT_OPTIONS: Array<{
  id: ContextMode;
  label: string;
  description: string;
  icon: React.ReactNode;
}> = [
  {
    id: "conversation",
    label: "Conversation",
    description: "Maintains full multi-turn chat history context.",
    icon: <SparklesIcon size={14} className="text-[var(--accent)]" />,
  },
  {
    id: "knowledge",
    label: "Knowledge base",
    description: "Performs RAG semantic search across uploaded documents via Vectorize.",
    icon: <BookOpenIcon size={14} className="text-amber-600 dark:text-amber-400" />,
  },
  {
    id: "files",
    label: "Attached files",
    description: "Injects text content from currently uploaded file attachments directly into the prompt.",
    icon: <FileTextIcon size={14} className="text-blue-600 dark:text-blue-400" />,
  },
  {
    id: "none",
    label: "None",
    description: "Ignores prior turns; treats this message as an isolated single prompt.",
    icon: <XIcon size={14} className="text-gray-400" />,
  },
];

export function ContextSelector({ value, onChange }: ContextSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const currentOption = CONTEXT_OPTIONS.find((opt) => opt.id === value) || CONTEXT_OPTIONS[0];

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }
    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  return (
    <div className="relative inline-block text-left" ref={dropdownRef}>
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium text-[var(--text-primary)] hover:bg-[var(--button-hover)] transition-colors border border-[var(--border)] bg-[var(--surface-bg)] shadow-xs"
        aria-label="Select Context Mode"
      >
        <span className="shrink-0">{currentOption.icon}</span>
        <span className="truncate max-w-[110px] sm:max-w-[130px]">{currentOption.label}</span>
        <ChevronDownIcon size={14} className="text-[var(--text-muted)] shrink-0 opacity-70" />
      </button>

      {isOpen && (
        <div className="absolute left-0 bottom-full mb-2 w-72 rounded-2xl border border-[var(--border)] bg-[var(--surface-bg)] p-2 shadow-xl z-50 animate-in fade-in zoom-in-95 duration-100">
          <div className="px-2 py-1 mb-1 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)] border-b border-[var(--border)]">
            Context Mode
          </div>
          <div className="space-y-1">
            {CONTEXT_OPTIONS.map((opt) => {
              const isSelected = opt.id === value;
              return (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => {
                    onChange(opt.id);
                    setIsOpen(false);
                  }}
                  className={`w-full text-left p-2 rounded-xl transition-all border ${
                    isSelected
                      ? "border-[var(--accent)] bg-[var(--selected-bg)]"
                      : "border-transparent hover:bg-[var(--button-hover)]"
                  }`}
                >
                  <div className="flex items-center gap-2 mb-0.5">
                    {opt.icon}
                    <span className="text-xs font-medium text-[var(--text-primary)]">{opt.label}</span>
                  </div>
                  <p className="text-[11px] text-[var(--text-muted)] leading-relaxed pl-5">
                    {opt.description}
                  </p>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
