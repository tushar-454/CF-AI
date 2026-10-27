"use client";

import React, { useState, useRef, useEffect } from "react";
import { ModelCategory, ModelInfo } from "@/lib/types";
import { BrainIcon, ChevronDownIcon, ImageIcon, SearchIcon, SparklesIcon } from "./Icons";

interface ModelSelectorProps {
  models: ModelInfo[];
  selectedModelId: string;
  onSelectModel: (id: string) => void;
  hasImageAttachment?: boolean;
}

const CATEGORIES: Array<"All" | ModelCategory> = ["All", "General", "Reasoning", "Coding", "Vision", "Fast/Small"];

export function ModelSelector({
  models,
  selectedModelId,
  onSelectModel,
  hasImageAttachment = false,
}: ModelSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState<"All" | ModelCategory>("All");
  const [searchQuery, setSearchQuery] = useState("");
  const dropdownRef = useRef<HTMLDivElement>(null);

  const selectedModel = models.find((m) => m.id === selectedModelId) || models[0];

  // Close dropdown on outside click
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

  // Filter models
  const filteredModels = models.filter((model) => {
    const matchesCategory = selectedCategory === "All" || model.category === selectedCategory;
    const matchesSearch =
      model.label.toLowerCase().includes(searchQuery.toLowerCase()) ||
      model.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
      model.id.toLowerCase().includes(searchQuery.toLowerCase());
    return matchesCategory && matchesSearch;
  });

  return (
    <div className="relative inline-block text-left" ref={dropdownRef}>
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium text-[var(--text-primary)] hover:bg-[var(--button-hover)] transition-colors border border-[var(--border)] bg-[var(--surface-bg)] shadow-xs"
        aria-label="Select AI Model"
      >
        <SparklesIcon size={14} className="text-[var(--accent)] shrink-0" />
        <span className="truncate max-w-[140px] sm:max-w-[180px] font-medium">{selectedModel?.label || "Select Model"}</span>
        <ChevronDownIcon size={14} className="text-[var(--text-muted)] shrink-0 opacity-70" />
      </button>

      {isOpen && (
        <div className="absolute left-0 bottom-full mb-2 w-80 sm:w-96 rounded-2xl border border-[var(--border)] bg-[var(--surface-bg)] p-3 shadow-xl z-50 animate-in fade-in zoom-in-95 duration-100">
          <div className="flex items-center justify-between pb-2 mb-2 border-b border-[var(--border)]">
            <span className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">Select Model</span>
            {hasImageAttachment && (
              <span className="text-[11px] font-medium text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/40 px-2 py-0.5 rounded-md border border-amber-200 dark:border-amber-800">
                Image requires Vision model
              </span>
            )}
          </div>

          {/* Search Input */}
          <div className="relative mb-2.5">
            <SearchIcon size={14} className="absolute left-2.5 top-2.5 text-[var(--text-muted)]" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search models..."
              className="w-full pl-8 pr-3 py-1.5 rounded-lg text-xs border border-[var(--border)] bg-[var(--input-bg)] text-[var(--text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
            />
          </div>

          {/* Category Filter Chips */}
          <div className="flex items-center gap-1 overflow-x-auto pb-2 mb-2 scrollbar-none">
            {CATEGORIES.map((cat) => (
              <button
                key={cat}
                type="button"
                onClick={() => setSelectedCategory(cat)}
                className={`px-2.5 py-1 rounded-full text-[11px] font-medium whitespace-nowrap transition-colors ${
                  selectedCategory === cat
                    ? "bg-[var(--accent)] text-white shadow-xs"
                    : "bg-[var(--badge-bg)] text-[var(--text-muted)] hover:bg-[var(--button-hover)] hover:text-[var(--text-primary)]"
                }`}
              >
                {cat}
              </button>
            ))}
          </div>

          {/* Model List */}
          <div className="max-h-64 overflow-y-auto space-y-1.5 pr-0.5">
            {filteredModels.length === 0 ? (
              <div className="text-center py-6 text-xs text-[var(--text-muted)]">No models match your search.</div>
            ) : (
              filteredModels.map((model) => {
                const isSelected = model.id === selectedModelId;
                const isIncompatibleWithImage = hasImageAttachment && !model.supportsVision;

                return (
                  <button
                    key={model.id}
                    type="button"
                    disabled={isIncompatibleWithImage}
                    onClick={() => {
                      onSelectModel(model.id);
                      setIsOpen(false);
                    }}
                    className={`w-full text-left p-2.5 rounded-xl transition-all border ${
                      isSelected
                        ? "border-[var(--accent)] bg-[var(--selected-bg)]"
                        : "border-transparent hover:bg-[var(--button-hover)]"
                    } ${isIncompatibleWithImage ? "opacity-40 cursor-not-allowed" : "cursor-pointer"}`}
                  >
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className="text-xs font-semibold text-[var(--text-primary)] truncate">{model.label}</span>
                        <span className="text-[10px] px-1.5 py-0.5 rounded-md font-mono bg-[var(--badge-bg)] text-[var(--text-muted)] shrink-0">
                          {model.category}
                        </span>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        {model.supportsReasoning && (
                          <span className="inline-flex items-center gap-0.5 text-[10px] text-purple-600 dark:text-purple-400 bg-purple-50 dark:bg-purple-950/40 px-1.5 py-0.5 rounded border border-purple-200 dark:border-purple-800" title="Supports step-by-step reasoning">
                            <BrainIcon size={11} /> Think
                          </span>
                        )}
                        {model.supportsVision && (
                          <span className="inline-flex items-center gap-0.5 text-[10px] text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/40 px-1.5 py-0.5 rounded border border-emerald-200 dark:border-emerald-800" title="Supports image analysis">
                            <ImageIcon size={11} /> Vision
                          </span>
                        )}
                      </div>
                    </div>
                    <p className="text-[11px] text-[var(--text-muted)] line-clamp-2 leading-relaxed">
                      {model.description}
                    </p>
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
