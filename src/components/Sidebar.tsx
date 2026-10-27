"use client";

import React, { useState, useMemo, useEffect } from "react";
import { Conversation } from "@/lib/types";
import { DailyUsageSummary } from "@/lib/db";
import { getAuthHeaders } from "@/lib/auth-client";
import {
  ActivityIcon,
  BookOpenIcon,
  CheckIcon,
  EditIcon,
  LinkIcon,
  LockIcon,
  MoonIcon,
  PlusIcon,
  SearchIcon,
  SunIcon,
  TrashIcon,
  XIcon,
} from "./Icons";

interface SidebarProps {
  conversations: Conversation[];
  activeConversationId?: string;
  onSelectConversation: (id: string) => void;
  onNewChat: () => void;
  onRenameConversation: (id: string, newTitle: string) => void;
  onDeleteConversation: (id: string) => void;
  onCopyLink?: (id: string) => void;
  onOpenKnowledgeBase: () => void;
  onOpenUsage?: () => void;
  onLockApp?: () => void;
  isOpenMobile: boolean;
  onCloseMobile: () => void;
  theme: "light" | "dark";
  onToggleTheme: () => void;
  usageSummary?: DailyUsageSummary | null;
}

export function Sidebar({
  conversations,
  activeConversationId,
  onSelectConversation,
  onNewChat,
  onRenameConversation,
  onDeleteConversation,
  onCopyLink,
  onOpenKnowledgeBase,
  onOpenUsage,
  onLockApp,
  isOpenMobile,
  onCloseMobile,
  theme,
  onToggleTheme,
  usageSummary,
}: SidebarProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [localUsage, setLocalUsage] = useState<DailyUsageSummary | null>(null);

  useEffect(() => {
    if (!usageSummary) {
      fetch("/api/usage", { headers: getAuthHeaders() })
        .then((res) => (res.ok ? res.json() : null))
        .then((data: unknown) => {
          const usageData = data as { currentUsage?: DailyUsageSummary } | null;
          if (usageData?.currentUsage) {
            setLocalUsage(usageData.currentUsage);
          }
        })
        .catch(() => {});
    }
  }, [usageSummary]);

  // Group conversations by date
  const groupedConversations = useMemo(() => {
    const filtered = conversations.filter((c) =>
      c.title.toLowerCase().includes(searchQuery.toLowerCase())
    );

    const now = new Date();
    const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const yesterdayMidnight = todayMidnight - 24 * 60 * 60 * 1000;
    const sevenDaysAgo = todayMidnight - 7 * 24 * 60 * 60 * 1000;

    const groups: {
      today: Conversation[];
      yesterday: Conversation[];
      last7Days: Conversation[];
      older: Conversation[];
    } = {
      today: [],
      yesterday: [],
      last7Days: [],
      older: [],
    };

    for (const c of filtered) {
      const time = c.updated_at || c.created_at;
      if (time >= todayMidnight) {
        groups.today.push(c);
      } else if (time >= yesterdayMidnight) {
        groups.yesterday.push(c);
      } else if (time >= sevenDaysAgo) {
        groups.last7Days.push(c);
      } else {
        groups.older.push(c);
      }
    }

    return groups;
  }, [conversations, searchQuery]);

  const startEditing = (c: Conversation) => {
    setEditingId(c.id);
    setEditingTitle(c.title);
  };

  const saveEditing = (id: string) => {
    if (editingTitle.trim()) {
      onRenameConversation(id, editingTitle.trim());
    }
    setEditingId(null);
  };

  const renderGroup = (title: string, list: Conversation[]) => {
    if (list.length === 0) return null;

    return (
      <div key={title} className="mb-4">
        <div className="px-3 pb-1 text-[11px] font-semibold text-[var(--text-muted)] tracking-wider uppercase">
          {title}
        </div>
        <div className="space-y-0.5">
          {list.map((c) => {
            const isActive = c.id === activeConversationId;
            const isEditing = c.id === editingId;

            return (
              <div
                key={c.id}
                className={`group relative flex items-center justify-between px-3 py-2 rounded-xl text-xs font-medium transition-all ${
                  isActive
                    ? "bg-[var(--selected-bg)] text-[var(--accent)] font-semibold"
                    : "text-[var(--text-primary)] hover:bg-[var(--button-hover)]"
                }`}
              >
                {isEditing ? (
                  <div className="flex items-center gap-1 w-full">
                    <input
                      type="text"
                      value={editingTitle}
                      onChange={(e) => setEditingTitle(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") saveEditing(c.id);
                        if (e.key === "Escape") setEditingId(null);
                      }}
                      onBlur={() => saveEditing(c.id)}
                      autoFocus
                      className="w-full px-2 py-0.5 rounded text-xs bg-[var(--input-bg)] border border-[var(--accent)] focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => saveEditing(c.id)}
                      className="p-1 hover:text-[var(--accent)]"
                    >
                      <CheckIcon size={14} />
                    </button>
                  </div>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        onSelectConversation(c.id);
                        onCloseMobile();
                      }}
                      className="truncate text-left flex-1 pr-2"
                      title={c.title}
                    >
                      {c.title}
                    </button>

                    <div className="flex items-center gap-0.5 sm:gap-1 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity shrink-0">
                      {onCopyLink && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onCopyLink(c.id);
                          }}
                          className="p-1.5 md:p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-bg)] transition-colors cursor-pointer"
                          title="Copy link to chat"
                          aria-label="Copy link"
                        >
                          <LinkIcon size={13} />
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          startEditing(c);
                        }}
                        className="p-1.5 md:p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-bg)] transition-colors cursor-pointer"
                        title="Rename"
                        aria-label="Rename chat"
                      >
                        <EditIcon size={13} />
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (confirm(`Delete "${c.title}"?`)) {
                            onDeleteConversation(c.id);
                          }
                        }}
                        className="p-1.5 md:p-1 rounded text-[var(--text-muted)] hover:text-red-500 hover:bg-red-500/10 transition-colors cursor-pointer"
                        title="Delete"
                        aria-label="Delete chat"
                      >
                        <TrashIcon size={13} />
                      </button>
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  const sidebarContent = (
    <div className="h-full flex flex-col justify-between bg-[var(--sidebar-bg)] border-r border-[var(--border)] text-[var(--text-primary)] w-72">
      {/* Top Header & Actions */}
      <div className="p-3">
        <div className="flex items-center justify-between mb-3 px-1">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-lg bg-[var(--accent)] flex items-center justify-center text-white font-serif font-bold text-sm shadow-xs">
              C
            </div>
            <span className="font-semibold text-sm tracking-tight">Cloudflare AI</span>
          </div>

          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={onToggleTheme}
              className="p-1.5 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--button-hover)] transition-colors"
              title={`Switch to ${theme === "light" ? "dark" : "light"} mode`}
            >
              {theme === "light" ? <MoonIcon size={15} /> : <SunIcon size={15} />}
            </button>
            {/* Mobile close button */}
            <button
              type="button"
              onClick={onCloseMobile}
              className="md:hidden p-1.5 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--button-hover)]"
            >
              <XIcon size={16} />
            </button>
          </div>
        </div>

        {/* New Chat Button */}
        <button
          type="button"
          onClick={() => {
            onNewChat();
            onCloseMobile();
          }}
          className="w-full mb-3 flex items-center justify-center gap-2 py-2 px-3 rounded-xl text-xs font-semibold bg-[var(--surface-bg)] hover:bg-[var(--button-hover)] border border-[var(--border)] transition-colors shadow-xs"
        >
          <PlusIcon size={15} className="text-[var(--accent)]" />
          <span>New Chat</span>
        </button>

        {/* Search */}
        <div className="relative mb-2">
          <SearchIcon size={13} className="absolute left-2.5 top-2.5 text-[var(--text-muted)]" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search conversations..."
            className="w-full pl-8 pr-3 py-1.5 rounded-lg text-xs bg-[var(--input-bg)] border border-[var(--border)] text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
          />
        </div>
      </div>

      {/* Conversations List */}
      <div className="flex-1 overflow-y-auto px-3 py-1">
        {conversations.length === 0 ? (
          <div className="text-center py-8 text-xs text-[var(--text-muted)]">No chats yet.</div>
        ) : (
          <>
            {renderGroup("Today", groupedConversations.today)}
            {renderGroup("Yesterday", groupedConversations.yesterday)}
            {renderGroup("Previous 7 days", groupedConversations.last7Days)}
            {renderGroup("Older", groupedConversations.older)}
          </>
        )}
      </div>

      {/* Bottom Knowledge Base & Usage actions */}
      <div className="p-3 border-t border-[var(--border)] flex flex-col gap-1">
        <button
          type="button"
          onClick={onOpenKnowledgeBase}
          className="w-full flex items-center justify-between px-3 py-2 rounded-xl text-xs font-medium text-[var(--text-primary)] hover:bg-[var(--button-hover)] border border-transparent hover:border-[var(--border)] transition-all"
        >
          <div className="flex items-center gap-2">
            <BookOpenIcon size={15} className="text-[var(--accent)]" />
            <span>Knowledge Base</span>
          </div>
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-[var(--badge-bg)] text-[var(--text-muted)]">
            Vectorize
          </span>
        </button>

        {onOpenUsage && (() => {
          const usage = usageSummary || localUsage;
          const limit = usage?.dailyFreeNeuronsLimit ?? 10000;
          const used = usage?.estimatedNeuronsUsedToday ?? 0;
          const remaining = usage?.remainingNeuronsToday ?? Math.max(0, limit - used);
          const percent = usage?.percentUsed ?? (limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0);

          const barColor =
            percent > 85
              ? "bg-red-500 dark:bg-red-400"
              : percent > 60
              ? "bg-amber-500 dark:bg-amber-400"
              : "bg-emerald-500 dark:bg-emerald-400";

          return (
            <button
              type="button"
              onClick={onOpenUsage}
              className="w-full flex flex-col p-2.5 rounded-xl text-xs font-medium text-[var(--text-primary)] hover:bg-[var(--button-hover)] border border-transparent hover:border-[var(--border)] transition-all cursor-pointer text-left group"
              title="Click to view detailed AI usage breakdown and limits"
            >
              {/* Top row: Label & % Used */}
              <div className="w-full flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <ActivityIcon size={15} className="text-[var(--accent)] shrink-0" />
                  <span className="font-semibold text-xs">Usage & Limits</span>
                </div>
                <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-[var(--badge-bg)] text-[var(--text-muted)] group-hover:text-[var(--text-primary)] transition-colors">
                  {percent}% used
                </span>
              </div>

              {/* Middle row: Progress line bar */}
              <div className="w-full mt-2 mb-1.5">
                <div className="w-full h-1.5 bg-[var(--border)]/70 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-500 ${barColor}`}
                    style={{ width: `${Math.max(used > 0 ? 3 : 0, Math.min(100, percent))}%` }}
                  />
                </div>
              </div>

              {/* Bottom row: Used & Remaining Neurons */}
              <div className="w-full flex items-center justify-between text-[10px] text-[var(--text-muted)] font-mono">
                <span>{used.toLocaleString()} used</span>
                <span className="font-sans font-medium text-[var(--text-primary)]/80">
                  {remaining.toLocaleString()} left
                </span>
              </div>
            </button>
          );
        })()}

        {onLockApp && (
          <button
            type="button"
            onClick={onLockApp}
            className="w-full flex items-center justify-between px-3 py-2 rounded-xl text-xs font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--button-hover)] border border-transparent hover:border-[var(--border)] transition-all cursor-pointer"
            title="Lock app with PIN"
          >
            <div className="flex items-center gap-2">
              <LockIcon size={15} />
              <span>Lock App</span>
            </div>
            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-[var(--badge-bg)] text-[var(--text-muted)]">
              PIN
            </span>
          </button>
        )}
      </div>
    </div>
  );

  return (
    <>
      {/* Desktop Persistent Sidebar */}
      <aside className="hidden md:block h-full shrink-0">
        {sidebarContent}
      </aside>

      {/* Mobile Drawer */}
      {isOpenMobile && (
        <div className="fixed inset-0 h-dvh z-50 md:hidden flex">
          <div
            className="fixed inset-0 bg-black/50 backdrop-blur-xs transition-opacity"
            onClick={onCloseMobile}
          />
          <div className="relative z-10 w-72 h-dvh max-h-dvh shadow-2xl">
            {sidebarContent}
          </div>
        </div>
      )}
    </>
  );
}
