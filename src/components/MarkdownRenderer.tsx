"use client"

import React, { useMemo } from "react"
import { marked } from "marked"

interface MarkdownRendererProps {
    content: string
}

export function MarkdownRenderer({ content }: MarkdownRendererProps) {
    const parsedHtml = useMemo(() => {
        try {
            return marked.parse(content, { async: false }) as string
        } catch {
            return content
        }
    }, [content])

    return (
        <div
            className="markdown-content prose max-w-none text-inherit leading-relaxed"
            dangerouslySetInnerHTML={{ __html: parsedHtml }}
            onClick={(e) => {
                const target = e.target as HTMLElement
                const copyBtn = target.closest("button.copy-code-btn") as HTMLButtonElement | null
                if (copyBtn) {
                    const rawCode = copyBtn.getAttribute("data-code")
                    if (rawCode) {
                        navigator.clipboard.writeText(decodeURIComponent(rawCode))
                        const iconSpan = copyBtn.querySelector(".copy-status-text")
                        if (iconSpan) {
                            const prev = iconSpan.textContent
                            iconSpan.textContent = "Copied!"
                            setTimeout(() => {
                                iconSpan.textContent = prev
                            }, 2000)
                        }
                    }
                }
            }}
        />
    )
}

if (typeof window !== "undefined") {
    const renderer = new marked.Renderer()

    renderer.code = function ({ text, lang }: { text: string; lang?: string }) {
        const language = lang || "plaintext"
        const encoded = encodeURIComponent(text)
        return `
      <div class="code-block my-4 rounded-xl overflow-hidden border border-[var(--border)] bg-[var(--code-bg)] text-[var(--code-text)] text-sm shadow-xs">
        <div class="flex items-center justify-between px-4 py-2 border-b border-[var(--border)] bg-[var(--code-header-bg)] text-xs text-[var(--text-muted)] font-mono">
          <span class="font-medium tracking-wide uppercase">${language}</span>
          <button class="copy-code-btn inline-flex items-center gap-1.5 px-2 py-1 rounded hover:bg-[var(--button-hover)] transition-colors text-xs font-sans text-[var(--text-primary)]" data-code="${encoded}">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
              <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
            </svg>
            <span class="copy-status-text">Copy code</span>
          </button>
        </div>
        <pre class="p-4 overflow-x-auto font-mono text-[13px] leading-relaxed m-0 custom-scrollbar"><code>${escapeHtml(text)}</code></pre>
      </div>
    `
    }

    renderer.link = function ({
        href,
        title,
        text,
    }: {
        href: string
        title?: string | null
        text: string
    }) {
        return `<a href="${href}" ${title ? `title="${title}"` : ""} target="_blank" rel="noopener noreferrer" class="text-[var(--accent)] underline underline-offset-2 hover:opacity-80">${text}</a>`
    }

    marked.setOptions({ renderer })
}

function escapeHtml(str: string): string {
    return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;")
}
