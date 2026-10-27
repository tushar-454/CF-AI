"use client";

import React, { useState, useRef, useEffect } from "react";
import { EffortLevel } from "@/lib/types";
import { ChevronDownIcon } from "./Icons";

interface EffortSelectorProps {
  value: EffortLevel;
  onChange: (level: EffortLevel) => void;
}

const EFFORT_OPTIONS: Array<{
  id: EffortLevel;
  label: string;
  tag: string;
  description: string;
}> = [
  {
    id: "low",
    label: "Low Effort",
    tag: "Fast & concise",
    description: "Lower temperature, direct answers, minimal tokens.",
  },
  {
    id: "medium",
    label: "Medium Effort",
    tag: "Balanced",
    description: "Standard balanced reasoning and thoroughness.",
  },
  {
    id: "high",
    label: "High Effort",
    tag: "Deep reasoning",
    description: "Maximum tokens, rigorous step-by-step thinking.",
  },
];

export function EffortSelector({ value, onChange }: EffortSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const currentOption = EFFORT_OPTIONS.find((opt) => opt.id === value) || EFFORT_OPTIONS[1];

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
        aria-label="Select Effort Level"
      >
        <span className="capitalize">{currentOption.label.replace(" Effort", "")}</span>
        <ChevronDownIcon size={14} className="text-[var(--text-muted)] shrink-0 opacity-70" />
      </button>

      {isOpen && (
        <div className="absolute left-0 bottom-full mb-2 w-64 rounded-2xl border border-[var(--border)] bg-[var(--surface-bg)] p-2 shadow-xl z-50 animate-in fade-in zoom-in-95 duration-100">
          <div className="px-2 py-1 mb-1 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)] border-b border-[var(--border)]">
            Effort Level
          </div>
          <div className="space-y-1">
            {EFFORT_OPTIONS.map((opt) => {
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
                  <div className="flex items-center justify-between mb-0.5">
                    <span className="text-xs font-medium text-[var(--text-primary)]">{opt.label}</span>
                    <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-[var(--badge-bg)] text-[var(--text-muted)]">
                      {opt.tag}
                    </span>
                  </div>
                  <p className="text-[11px] text-[var(--text-muted)] leading-relaxed">{opt.description}</p>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
