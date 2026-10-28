"use client"

import React, { useState } from "react"
import { AlertCircleIcon, ArrowRightIcon, PlayIcon, SparklesIcon } from "./Icons"
import { parseYouTubeUrl } from "@/lib/youtube-url"
import type { YoutubeProgressEvent } from "@/lib/types"

interface YouTubeUrlEntryProps {
    onSubmitUrl: (url: string) => Promise<void>
    onConfirmAiTranscription?: (videoId: string, confirmed: boolean) => Promise<void>
    isProcessing: boolean
    progressEvent: YoutubeProgressEvent | null
    errorMessage: string | null
    onRetry?: () => void
}

const SAMPLE_VIDEOS = [
    {
        title: "Introduction to Cloudflare Workers",
        url: "https://www.youtube.com/watch?v=0kwtY-sC_8M",
    },
    {
        title: "Quantum Physics in 10 Minutes",
        url: "https://www.youtube.com/watch?v=Da-2h2B4faU",
    },
    {
        title: "How Large Language Models Work",
        url: "https://www.youtube.com/watch?v=wjZofJX0v4U",
    },
]

export function YouTubeUrlEntry({
    onSubmitUrl,
    onConfirmAiTranscription,
    isProcessing,
    progressEvent,
    errorMessage,
    onRetry,
}: YouTubeUrlEntryProps) {
    const [inputUrl, setInputUrl] = useState("")
    const [clientValidationError, setClientValidationError] = useState<string | null>(null)

    const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setInputUrl(e.target.value)
        if (clientValidationError) {
            setClientValidationError(null)
        }
    }

    const handleSubmit = async (e?: React.FormEvent) => {
        if (e) e.preventDefault()
        const trimmed = inputUrl.trim()
        if (!trimmed) {
            setClientValidationError("Please enter a valid YouTube video URL.")
            return
        }

        const parsed = parseYouTubeUrl(trimmed)
        if (!parsed.isValid) {
            setClientValidationError(parsed.error)
            return
        }

        setClientValidationError(null)
        await onSubmitUrl(parsed.canonicalUrl)
    }

    const handleSelectSample = (url: string) => {
        setInputUrl(url)
        setClientValidationError(null)
    }

    const isAwaitingConfirmation =
        progressEvent?.status === "awaiting_confirmation" || progressEvent?.needsConfirmation

    return (
        <div className="flex-1 h-full overflow-y-auto flex flex-col items-center justify-center p-4 md:p-8">
            <div className="w-full max-w-xl mx-auto flex flex-col items-center text-center">
                {/* Brand Badge */}
                <div className="w-12 h-12 rounded-2xl bg-red-600/10 dark:bg-red-500/15 text-red-600 dark:text-red-400 flex items-center justify-center mb-4 shadow-xs">
                    <PlayIcon size={24} />
                </div>

                <h1 className="text-2xl md:text-3xl font-serif font-bold tracking-tight text-[var(--text-primary)] mb-2">
                    Chat with any YouTube Video
                </h1>
                <p className="text-xs md:text-sm text-[var(--text-muted)] max-w-md mb-8 leading-relaxed">
                    Extract captions, synchronize playback, and ask grounded questions powered by
                    DeepSeek R1 reasoning and Cloudflare Vectorize.
                </p>

                {/* Main URL Input Card */}
                <div className="w-full bg-[var(--surface-bg)] border border-[var(--border)] rounded-2xl p-4 md:p-6 shadow-sm">
                    <form onSubmit={handleSubmit} className="flex flex-col gap-3">
                        <div className="relative flex items-center">
                            <input
                                type="text"
                                value={inputUrl}
                                onChange={handleInputChange}
                                disabled={isProcessing}
                                placeholder="Paste YouTube video link (e.g. youtube.com/watch?v=...)"
                                className="w-full pl-4 pr-12 py-3 rounded-xl text-sm bg-[var(--input-bg)] border border-[var(--border)] text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:ring-2 focus:ring-red-500/30 focus:border-red-500 transition-all disabled:opacity-50"
                            />
                            <button
                                type="submit"
                                disabled={isProcessing || !inputUrl.trim()}
                                className="absolute right-2 p-2 rounded-lg bg-red-600 hover:bg-red-700 disabled:opacity-40 text-white transition-colors cursor-pointer"
                                title="Process Video"
                            >
                                <ArrowRightIcon size={16} />
                            </button>
                        </div>

                        {/* Inline Client Validation Error */}
                        {clientValidationError && (
                            <div className="flex items-center gap-1.5 text-xs text-red-500 text-left px-1">
                                <AlertCircleIcon size={13} className="shrink-0" />
                                <span>{clientValidationError}</span>
                            </div>
                        )}
                    </form>

                    {/* Real-time Progress & Status Indicator */}
                    {isProcessing && (
                        <div className="mt-5 pt-4 border-t border-[var(--border)] text-left flex flex-col gap-2">
                            <div className="flex items-center justify-between text-xs font-medium text-[var(--text-primary)]">
                                <span className="capitalize">
                                    {progressEvent?.stage?.replace(/_/g, " ") ||
                                        "Processing video..."}
                                </span>
                                <span className="font-mono text-[var(--text-muted)]">
                                    {progressEvent?.progress ?? 15}%
                                </span>
                            </div>

                            {/* Progress bar */}
                            <div className="w-full h-2 bg-[var(--border)] rounded-full overflow-hidden">
                                <div
                                    className="h-full bg-red-600 rounded-full transition-all duration-300"
                                    style={{
                                        width: `${Math.max(5, progressEvent?.progress ?? 15)}%`,
                                    }}
                                />
                            </div>

                            <p className="text-[11px] text-[var(--text-muted)] mt-1">
                                {progressEvent?.message ||
                                    "Validating video and preparing vector index..."}
                            </p>
                        </div>
                    )}

                    {/* AI Transcription Confirmation Dialog */}
                    {isAwaitingConfirmation && progressEvent?.videoId && (
                        <div className="mt-5 pt-4 border-t border-[var(--border)] text-left flex flex-col gap-3 bg-amber-500/10 dark:bg-amber-400/10 p-4 rounded-xl border-amber-500/20">
                            <div className="flex items-start gap-2.5">
                                <SparklesIcon
                                    size={18}
                                    className="text-amber-500 shrink-0 mt-0.5"
                                />
                                <div className="flex flex-col gap-1">
                                    <span className="font-semibold text-xs text-[var(--text-primary)]">
                                        No Native Captions Found
                                    </span>
                                    <p className="text-[11px] text-[var(--text-muted)] leading-relaxed">
                                        This video does not have native YouTube subtitles. AI
                                        speech-to-text transcription is available. Would you like to
                                        proceed with transcribing this video?
                                    </p>
                                </div>
                            </div>

                            <div className="flex items-center justify-end gap-2 mt-1">
                                <button
                                    type="button"
                                    onClick={() =>
                                        onConfirmAiTranscription?.(progressEvent.videoId, false)
                                    }
                                    className="px-3 py-1.5 rounded-lg text-xs font-medium text-[var(--text-muted)] hover:bg-[var(--button-hover)] transition-colors"
                                >
                                    Cancel
                                </button>
                                <button
                                    type="button"
                                    onClick={() =>
                                        onConfirmAiTranscription?.(progressEvent.videoId, true)
                                    }
                                    className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-amber-600 hover:bg-amber-700 text-white transition-colors cursor-pointer"
                                >
                                    Transcribe with AI
                                </button>
                            </div>
                        </div>
                    )}

                    {/* Processing Failure and Retry */}
                    {errorMessage && !isProcessing && (
                        <div className="mt-5 pt-4 border-t border-[var(--border)] text-left flex flex-col gap-2">
                            <div className="flex items-start gap-2 p-3 rounded-xl bg-red-500/10 text-red-500 border border-red-500/20 text-xs">
                                <AlertCircleIcon size={16} className="shrink-0 mt-0.5" />
                                <div className="flex-1">
                                    <span className="font-semibold block mb-0.5">
                                        Processing Failed
                                    </span>
                                    <span>{errorMessage}</span>
                                </div>
                            </div>

                            {onRetry && (
                                <button
                                    type="button"
                                    onClick={onRetry}
                                    className="self-end px-3 py-1.5 rounded-lg text-xs font-semibold bg-[var(--surface-bg)] hover:bg-[var(--button-hover)] border border-[var(--border)] text-[var(--text-primary)] transition-colors cursor-pointer"
                                >
                                    Try Again
                                </button>
                            )}
                        </div>
                    )}
                </div>

                {/* Sample Videos to Try */}
                <div className="w-full mt-8 text-left">
                    <span className="text-[11px] font-semibold text-[var(--text-muted)] tracking-wider uppercase block mb-3 px-1">
                        Try Sample Videos
                    </span>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                        {SAMPLE_VIDEOS.map((item) => (
                            <button
                                key={item.url}
                                type="button"
                                onClick={() => handleSelectSample(item.url)}
                                className="flex flex-col p-3 rounded-xl bg-[var(--surface-bg)] hover:bg-[var(--button-hover)] border border-[var(--border)] text-left transition-all group cursor-pointer"
                            >
                                <span className="font-semibold text-xs text-[var(--text-primary)] group-hover:text-red-500 transition-colors line-clamp-1 mb-1">
                                    {item.title}
                                </span>
                                <span className="text-[10px] text-[var(--text-muted)] font-mono truncate">
                                    {item.url.replace("https://www.", "")}
                                </span>
                            </button>
                        ))}
                    </div>
                </div>
            </div>
        </div>
    )
}
