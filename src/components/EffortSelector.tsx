"use client";

import React, { useState, useRef, useEffect } from "react";
import { EffortLevel } from "@/lib/types";
import { BrainIcon, ChevronDownIcon, XIcon } from "./Icons";

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

  // Prevent background scrolling on mobile when sheet is open
  useEffect(() => {
    if (isOpen && window.innerWidth < 640) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [isOpen]);

  const renderOptionList = (isMobile: boolean = false) => (
    <div className={`space-y-1.5 ${isMobile ? "max-h-[60vh] overflow-y-auto pr-1" : ""}`}>
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
            className={`w-full text-left p-3 sm:p-2 rounded-xl transition-all border ${
              isSelected
                ? "border-[var(--accent)] bg-[var(--selected-bg)] ring-1 ring-[var(--accent)]/30"
                : "border-[var(--border)]/40 hover:bg-[var(--button-hover)] hover:border-[var(--border)]"
            } active:scale-[0.99] cursor-pointer`}
          >
            <div className="flex items-center justify-between mb-1">
              <div className="flex items-center gap-2">
                <BrainIcon
                  size={14}
                  className={isSelected ? "text-[var(--accent)]" : "text-purple-600 dark:text-purple-400"}
                />
                <span className="text-xs font-semibold text-[var(--text-primary)]">{opt.label}</span>
              </div>
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-[var(--badge-bg)] text-[var(--text-muted)] border border-[var(--border)]/40">
                {opt.tag}
              </span>
            </div>
            <p className="text-[11px] text-[var(--text-muted)] leading-relaxed pl-6">{opt.description}</p>
          </button>
        );
      })}
    </div>
  );

  return (
    <div className="relative inline-block text-left" ref={dropdownRef}>
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="inline-flex items-center gap-1 sm:gap-1.5 px-2 sm:px-2.5 py-1.5 rounded-xl text-xs font-medium text-[var(--text-primary)] hover:bg-[var(--button-hover)] transition-colors border border-[var(--border)] bg-[var(--surface-bg)] shadow-xs shrink-0 whitespace-nowrap cursor-pointer"
        aria-label="Select Effort Level"
        title="Reasoning Effort & Thinking Depth"
      >
        <BrainIcon size={13} className="text-purple-600 dark:text-purple-400 shrink-0" />
        <span className="capitalize font-medium">
          <span className="hidden xs:inline">Think: </span>
          {currentOption.label.replace(" Effort", "")}
        </span>
        <ChevronDownIcon size={13} className="text-[var(--text-muted)] shrink-0 opacity-70" />
      </button>

      {isOpen && (
        <>
          {/* Mobile Bottom Sheet Drawer (< 640px) */}
          <div className="fixed inset-0 z-50 flex flex-col justify-end sm:hidden">
            <div
              className="fixed inset-0 bg-black/60 backdrop-blur-xs transition-opacity"
              onClick={() => setIsOpen(false)}
            />
            <div className="relative w-full max-h-[85vh] bg-[var(--surface-bg)] rounded-t-3xl border-t border-[var(--border)] shadow-2xl flex flex-col overflow-hidden z-10 animate-in slide-in-from-bottom duration-200">
              <div className="w-10 h-1 bg-[var(--border)] rounded-full mx-auto mt-2.5 mb-1 shrink-0" />

              <div className="p-4 flex flex-col h-full overflow-hidden">
                <div className="flex items-center justify-between pb-2 mb-2 border-b border-[var(--border)] shrink-0">
                  <div className="flex items-center gap-2">
                    <div className="p-1 rounded-lg bg-purple-500/10 text-purple-600 dark:text-purple-400">
                      <BrainIcon size={16} />
                    </div>
                    <div>
                      <h3 className="text-sm font-semibold text-[var(--text-primary)]">Reasoning Effort</h3>
                      <p className="text-[11px] text-[var(--text-muted)]">Control step-by-step thinking depth</p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setIsOpen(false)}
                    className="p-1.5 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--button-hover)] cursor-pointer"
                    aria-label="Close"
                  >
                    <XIcon size={18} />
                  </button>
                </div>

                {renderOptionList(true)}
              </div>
            </div>
          </div>

          {/* Desktop Floating Popover (>= 640px) */}
          <div className="hidden sm:block absolute left-0 bottom-full mb-2 w-64 rounded-2xl border border-[var(--border)] bg-[var(--surface-bg)] p-2 shadow-xl z-50 animate-in fade-in zoom-in-95 duration-100">
            <div className="px-2 py-1 mb-1 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)] border-b border-[var(--border)] flex items-center justify-between">
              <span>Effort Level</span>
              <BrainIcon size={12} className="text-purple-500" />
            </div>
            {renderOptionList(false)}
          </div>
        </>
      )}
    </div>
  );
}
