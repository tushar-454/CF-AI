"use client"

import React, { useState, useEffect, useCallback } from "react"
import { ClockIcon } from "./Icons"

export type TimeFormatMode = "both" | "utc" | "local"

const STORAGE_KEY = "cf_ai_time_format"
const EVENT_NAME = "cf_ai_time_format_change"

interface MessageTimestampProps {
    timestamp?: number | null
    className?: string
    align?: "left" | "right"
}

export function MessageTimestamp({
    timestamp,
    className = "",
    align = "left",
}: MessageTimestampProps) {
    const [mounted, setMounted] = useState(false)
    const [formatMode, setFormatMode] = useState<TimeFormatMode>("both")

    // Read stored format preference and listen for changes
    useEffect(() => {
        setMounted(true)
        const saved = (localStorage.getItem(STORAGE_KEY) as TimeFormatMode) || "both"
        if (saved === "both" || saved === "utc" || saved === "local") {
            setFormatMode(saved)
        }

        const handleSync = () => {
            const current = (localStorage.getItem(STORAGE_KEY) as TimeFormatMode) || "both"
            setFormatMode(current)
        }

        window.addEventListener(EVENT_NAME, handleSync)
        return () => window.removeEventListener(EVENT_NAME, handleSync)
    }, [])

    const handleToggleFormat = useCallback((e: React.MouseEvent) => {
        e.stopPropagation()
        setFormatMode((prev) => {
            const next: TimeFormatMode = prev === "both" ? "utc" : prev === "utc" ? "local" : "both"
            try {
                localStorage.setItem(STORAGE_KEY, next)
                window.dispatchEvent(new Event(EVENT_NAME))
            } catch {
                // Ignore storage errors
            }
            return next
        })
    }, [])

    if (!timestamp) return null

    const numTimestamp = Number(timestamp)
    if (isNaN(numTimestamp) || numTimestamp <= 0) return null

    const date = new Date(numTimestamp)
    if (isNaN(date.getTime())) return null

    // Deterministic UTC time formatting (identical on SSR & Client)
    const utcHours = String(date.getUTCHours()).padStart(2, "0")
    const utcMinutes = String(date.getUTCMinutes()).padStart(2, "0")
    const utcTimeShort = `${utcHours}:${utcMinutes} UTC`
    const utcIsoString = date.toISOString().replace("T", " ").slice(0, 19) + " UTC"

    // Client-side local time formatting based on user's browser locale and timezone
    let localTimeShort = ""
    let localTimeFull = ""
    let userTz = "Local"

    if (mounted) {
        try {
            userTz = Intl.DateTimeFormat().resolvedOptions().timeZone || "Local"
            localTimeShort = date.toLocaleTimeString([], {
                hour: "numeric",
                minute: "2-digit",
            })
            localTimeFull = date.toLocaleString([], {
                weekday: "short",
                year: "numeric",
                month: "short",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
                second: "2-digit",
                timeZoneName: "short",
            })
        } catch {
            localTimeShort = `${date.getHours()}:${String(date.getMinutes()).padStart(2, "0")}`
            localTimeFull = date.toLocaleString()
        }
    }

    const tooltip = mounted
        ? `Stored UTC: ${utcIsoString}\nLocal: ${localTimeFull} (${userTz})\n[Click to toggle format: Both / UTC / Local]`
        : `Stored UTC: ${utcIsoString}`

    return (
        <button
            type="button"
            onClick={handleToggleFormat}
            title={tooltip}
            aria-label={`Timestamp: ${utcTimeShort}. Click to toggle time format.`}
            className={`inline-flex items-center gap-1.5 px-1.5 py-0.5 -mx-1 rounded-md text-[10.5px] font-mono tracking-tight text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--button-hover)]/70 transition-colors cursor-pointer select-none group ${
                align === "right" ? "justify-end" : "justify-start"
            } ${className}`}
        >
            <ClockIcon
                size={11}
                className="opacity-70 group-hover:opacity-100 group-hover:text-[var(--accent)] shrink-0 transition-opacity"
            />

            {!mounted ? (
                // SSR fallback to prevent hydration mismatch
                <span>{utcTimeShort}</span>
            ) : formatMode === "both" ? (
                <span className="inline-flex items-center gap-1">
                    <span className="font-medium text-[var(--text-primary)]/80">
                        {utcTimeShort}
                    </span>
                    <span className="text-[var(--text-muted)] opacity-75">• {localTimeShort}</span>
                </span>
            ) : formatMode === "utc" ? (
                <span className="font-medium text-[var(--text-primary)]/90">{utcTimeShort}</span>
            ) : (
                <span className="font-medium text-[var(--text-primary)]/90">
                    {localTimeShort}
                    <span className="text-[9px] text-[var(--text-muted)] ml-1 opacity-70">
                        (local)
                    </span>
                </span>
            )}
        </button>
    )
}
