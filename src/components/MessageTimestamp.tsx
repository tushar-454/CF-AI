"use client"

import React, { useState, useEffect } from "react"
import { ClockIcon } from "./Icons"

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

    useEffect(() => {
        setMounted(true)
    }, [])

    if (!timestamp) return null

    const numTimestamp = Number(timestamp)
    if (isNaN(numTimestamp) || numTimestamp <= 0) return null

    const date = new Date(numTimestamp)
    if (isNaN(date.getTime())) return null

    let localTimeWithSeconds = ""
    let localTimeFull = ""
    let userTz = ""

    if (mounted) {
        try {
            userTz = Intl.DateTimeFormat().resolvedOptions().timeZone || ""
            localTimeWithSeconds = date.toLocaleTimeString([], {
                hour: "numeric",
                minute: "2-digit",
                second: "2-digit",
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
            localTimeWithSeconds = date.toTimeString().split(" ")[0]
            localTimeFull = date.toLocaleString()
        }
    }

    const tooltip = mounted ? (userTz ? `${localTimeFull} (${userTz})` : localTimeFull) : ""

    return (
        <span
            title={tooltip}
            className={`inline-flex items-center gap-1.5 px-1 py-0.5 rounded-md text-[10.5px] font-mono tracking-tight text-[var(--text-muted)] select-none ${
                align === "right" ? "justify-end" : "justify-start"
            } ${className}`}
        >
            <ClockIcon size={11} className="opacity-70 text-[var(--accent)] shrink-0" />
            {mounted ? (
                <span className="font-medium text-[var(--text-primary)]/80">
                    {localTimeWithSeconds}
                </span>
            ) : (
                <span className="opacity-0">--:--:--</span>
            )}
        </span>
    )
}
