"use client"

import React, { useEffect, useMemo, useRef, useState } from "react"
import { CheckIcon, CopyIcon, PlayIcon, SearchIcon } from "./Icons"
import type { TranscriptSegment } from "@/lib/types"
import { findActiveSegmentIndex, formatTimestamp } from "@/lib/youtube-chunker"

interface YouTubeTranscriptPanelProps {
    segments: TranscriptSegment[]
    currentTime: number
    onSeek: (seconds: number) => void
    lang?: string
    className?: string
}

export const YouTubeTranscriptPanel = React.memo(function YouTubeTranscriptPanel({
    segments,
    currentTime,
    onSeek,
    lang,
    className = "",
}: YouTubeTranscriptPanelProps) {
    const [searchQuery, setSearchQuery] = useState("")
    const [autoScroll, setAutoScroll] = useState(true)
    const [copied, setCopied] = useState(false)
    const containerRef = useRef<HTMLDivElement>(null)
    const segmentRefs = useRef<Map<number, HTMLDivElement>>(new Map())
    const userScrolledRef = useRef(false)
    const userScrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

    // Compute active segment index using O(log N) binary search
    const activeIndex = useMemo(() => {
        return findActiveSegmentIndex(segments, currentTime)
    }, [segments, currentTime])

    // Filter segments based on search query
    const filteredSegments = useMemo(() => {
        if (!searchQuery.trim()) {
            return segments.map((s, idx) => ({ segment: s, originalIndex: idx }))
        }
        const query = searchQuery.toLowerCase()
        return segments
            .map((s, idx) => ({ segment: s, originalIndex: idx }))
            .filter((item) => item.segment.text.toLowerCase().includes(query))
    }, [segments, searchQuery])

    // Smoothly scroll active segment into view if auto-scroll is enabled and user hasn't recently scrolled
    useEffect(() => {
        if (!autoScroll || userScrolledRef.current || activeIndex < 0) return

        const el = segmentRefs.current.get(activeIndex)
        if (el && containerRef.current) {
            el.scrollIntoView({
                behavior: "smooth",
                block: "nearest",
            })
        }
    }, [activeIndex, autoScroll])

    // Handle user manual scrolling: pause auto-scroll temporarily (3 seconds)
    const handleScroll = () => {
        userScrolledRef.current = true
        if (userScrollTimerRef.current) {
            clearTimeout(userScrollTimerRef.current)
        }
        userScrollTimerRef.current = setTimeout(() => {
            userScrolledRef.current = false
        }, 3000)
    }

    const handleCopyAll = async () => {
        const fullText = segments
            .map((s) => `[${formatTimestamp(s.startSeconds)}] ${s.text}`)
            .join("\n")
        try {
            await navigator.clipboard.writeText(fullText)
            setCopied(true)
            setTimeout(() => setCopied(false), 2000)
        } catch {}
    }

    const handleSegmentClick = (seconds: number) => {
        userScrolledRef.current = false
        onSeek(seconds)
    }

    return (
        <div
            className={`flex flex-col h-full bg-[var(--surface-bg)] rounded-2xl border border-[var(--border)] overflow-hidden shadow-xs min-h-0 ${className}`}
        >
            {/* Header / Search bar */}
            <div className="p-3 border-b border-[var(--border)] flex flex-col gap-2 shrink-0">
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <span className="font-semibold text-xs tracking-tight text-[var(--text-primary)]">
                            Transcript
                        </span>
                        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-[var(--badge-bg)] text-[var(--text-muted)]">
                            {segments.length} lines
                        </span>
                        {(lang || segments[0]?.lang) && (
                            <span className="text-[10px] font-mono uppercase px-1.5 py-0.5 rounded bg-[var(--accent)]/10 text-[var(--accent)] font-semibold">
                                {(lang || segments[0]?.lang) === "bn"
                                    ? "Bangla (CC)"
                                    : (lang || segments[0]?.lang) === "en"
                                      ? "English (CC)"
                                      : `${(lang || segments[0]?.lang)?.toUpperCase()} (CC)`}
                            </span>
                        )}
                    </div>

                    <div className="flex items-center gap-1.5">
                        <button
                            type="button"
                            onClick={() => setAutoScroll((prev) => !prev)}
                            className={`text-[10px] font-medium px-2 py-1 rounded-md transition-colors ${
                                autoScroll
                                    ? "bg-[var(--accent)]/10 text-[var(--accent)] font-semibold"
                                    : "text-[var(--text-muted)] hover:bg-[var(--button-hover)]"
                            }`}
                            title={
                                autoScroll ? "Disable automatic scroll" : "Enable automatic scroll"
                            }
                        >
                            Sync {autoScroll ? "ON" : "OFF"}
                        </button>
                        <button
                            type="button"
                            onClick={handleCopyAll}
                            className="p-1.5 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--button-hover)] transition-colors"
                            title="Copy entire transcript"
                        >
                            {copied ? (
                                <CheckIcon size={14} className="text-emerald-500" />
                            ) : (
                                <CopyIcon size={14} />
                            )}
                        </button>
                    </div>
                </div>

                {/* Search query input */}
                <div className="relative">
                    <SearchIcon
                        size={12}
                        className="absolute left-2.5 top-2.5 text-[var(--text-muted)]"
                    />
                    <input
                        type="text"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        placeholder="Search transcript..."
                        className="w-full pl-8 pr-3 py-1.5 rounded-lg text-xs bg-[var(--input-bg)] border border-[var(--border)] text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
                    />
                </div>
            </div>

            {/* Scrollable Transcript List */}
            <div
                ref={containerRef}
                onScroll={handleScroll}
                className="flex-1 min-h-0 overflow-y-auto p-2 space-y-1 custom-scrollbar"
            >
                {filteredSegments.length === 0 ? (
                    <div className="text-center py-12 text-xs text-[var(--text-muted)]">
                        {segments.length === 0
                            ? "No transcript segments available."
                            : "No matching segments found."}
                    </div>
                ) : (
                    filteredSegments.map(({ segment, originalIndex }) => {
                        const isActive = originalIndex === activeIndex

                        return (
                            <div
                                key={segment.id || `seg_${originalIndex}`}
                                ref={(el) => {
                                    if (el) {
                                        segmentRefs.current.set(originalIndex, el)
                                    } else {
                                        segmentRefs.current.delete(originalIndex)
                                    }
                                }}
                                onClick={() => handleSegmentClick(segment.startSeconds)}
                                className={`group flex items-start gap-2.5 p-2 rounded-xl text-xs cursor-pointer transition-all duration-150 ${
                                    isActive
                                        ? "bg-[var(--selected-bg)] border border-[var(--accent)]/30 text-[var(--accent)] font-medium shadow-xs"
                                        : "hover:bg-[var(--button-hover)] text-[var(--text-primary)] border border-transparent"
                                }`}
                            >
                                <button
                                    type="button"
                                    onClick={(e) => {
                                        e.stopPropagation()
                                        handleSegmentClick(segment.startSeconds)
                                    }}
                                    className={`shrink-0 inline-flex items-center gap-1 font-mono text-[11px] px-1.5 py-0.5 rounded-md transition-colors ${
                                        isActive
                                            ? "bg-[var(--accent)] text-white font-semibold"
                                            : "bg-[var(--badge-bg)] text-[var(--text-muted)] group-hover:text-[var(--text-primary)]"
                                    }`}
                                    title={`Seek to ${formatTimestamp(segment.startSeconds)}`}
                                >
                                    <PlayIcon size={9} />
                                    <span>{formatTimestamp(segment.startSeconds)}</span>
                                </button>

                                <span className="flex-1 leading-relaxed select-text">
                                    {segment.text}
                                </span>
                            </div>
                        )
                    })
                )}
            </div>
        </div>
    )
})
