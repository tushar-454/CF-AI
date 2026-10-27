"use client";

import React, { useEffect } from "react";
import { AlertCircleIcon, CheckIcon, XIcon } from "./Icons";

export interface ToastMessage {
  id: string;
  message: string;
  isError?: boolean;
}

interface ToastProps {
  toasts: ToastMessage[];
  onDismiss: (id: string) => void;
}

export function Toast({ toasts, onDismiss }: ToastProps) {
  useEffect(() => {
    if (toasts.length === 0) return;
    const timer = setTimeout(() => {
      onDismiss(toasts[0].id);
    }, 4500);
    return () => clearTimeout(timer);
  }, [toasts, onDismiss]);

  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-2 max-w-sm pointer-events-none">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`pointer-events-auto flex items-center justify-between gap-3 p-3.5 rounded-2xl shadow-xl border text-xs font-medium backdrop-blur-md animate-in slide-in-from-bottom-3 duration-200 ${
            toast.isError
              ? "bg-red-50/95 dark:bg-red-950/90 border-red-200 dark:border-red-900 text-red-700 dark:text-red-300"
              : "bg-[var(--surface-bg)] border-[var(--border)] text-[var(--text-primary)]"
          }`}
        >
          <div className="flex items-center gap-2.5">
            {toast.isError ? (
              <AlertCircleIcon size={16} className="text-red-500 shrink-0" />
            ) : (
              <CheckIcon size={16} className="text-emerald-500 shrink-0" />
            )}
            <span>{toast.message}</span>
          </div>
          <button
            type="button"
            onClick={() => onDismiss(toast.id)}
            className="p-1 rounded-md opacity-60 hover:opacity-100 transition-opacity"
          >
            <XIcon size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
