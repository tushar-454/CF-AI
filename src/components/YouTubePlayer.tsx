"use client"

import React, { useEffect, useRef, useState, useImperativeHandle, forwardRef, memo } from "react"
import { AlertCircleIcon, PlayIcon } from "./Icons"

export interface YouTubePlayerRef {
    seekTo: (seconds: number, allowSeekAhead?: boolean, autoPlay?: boolean) => void
    play: () => void
    pause: () => void
    getCurrentTime: () => number
}

interface YouTubePlayerProps {
    videoId: string
    lang?: string
    onTimeUpdate?: (seconds: number) => void
    onPlayStateChange?: (isPlaying: boolean) => void
    onReady?: () => void
    className?: string
}

declare global {
    interface Window {
        YT: {
            Player: new (
                elementId: string | HTMLElement,
                options: {
                    videoId?: string
                    width?: string | number
                    height?: string | number
                    playerVars?: Record<string, unknown>
                    events?: {
                        onReady?: (event: { target: YTPlayerInstance }) => void
                        onStateChange?: (event: { data: number; target: YTPlayerInstance }) => void
                        onError?: (event: { data: number }) => void
                    }
                }
            ) => YTPlayerInstance
            PlayerState: {
                UNSTARTED: -1
                ENDED: 0
                PLAYING: 1
                PAUSED: 2
                BUFFERING: 3
                CUED: 5
            }
        }
        onYouTubeIframeAPIReady?: () => void
    }
}

interface YTPlayerInstance {
    seekTo: (seconds: number, allowSeekAhead?: boolean) => void
    playVideo: () => void
    pauseVideo: () => void
    getCurrentTime: () => number
    getPlayerState: () => number
    destroy: () => void
}

let iframeApiPromise: Promise<void> | null = null

function loadYouTubeIframeApi(): Promise<void> {
    if (typeof window === "undefined") return Promise.resolve()
    if (window.YT && window.YT.Player) {
        return Promise.resolve()
    }
    if (iframeApiPromise) {
        return iframeApiPromise
    }

    iframeApiPromise = new Promise((resolve) => {
        const prevHandler = window.onYouTubeIframeAPIReady
        window.onYouTubeIframeAPIReady = () => {
            if (prevHandler) prevHandler()
            resolve()
        }

        const existingTag = document.querySelector('script[src*="youtube.com/iframe_api"]')
        if (!existingTag) {
            const tag = document.createElement("script")
            tag.src = "https://www.youtube.com/iframe_api"
            tag.async = true
            document.head.appendChild(tag)
        }
    })

    return iframeApiPromise
}

export const YouTubePlayer = memo(
    forwardRef<YouTubePlayerRef, YouTubePlayerProps>(function YouTubePlayer(
        { videoId, lang = "en", onTimeUpdate, onPlayStateChange, onReady, className = "" },
        ref
    ) {
        const containerRef = useRef<HTMLDivElement>(null)
        const playerRef = useRef<YTPlayerInstance | null>(null)
        const timeIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
        const pendingSeekRef = useRef<{ seconds: number; autoPlay: boolean } | null>(null)
        const [isPlayerReady, setIsPlayerReady] = useState(false)
        const [playbackError, setPlaybackError] = useState<string | null>(null)

        // Store callbacks in refs to decouple callback identity changes from player lifecycle
        const onTimeUpdateRef = useRef(onTimeUpdate)
        const onPlayStateChangeRef = useRef(onPlayStateChange)
        const onReadyRef = useRef(onReady)

        useEffect(() => {
            onTimeUpdateRef.current = onTimeUpdate
            onPlayStateChangeRef.current = onPlayStateChange
            onReadyRef.current = onReady
        })

        // Expose seekTo, play, pause, getCurrentTime via ref
        useImperativeHandle(
            ref,
            () => ({
                seekTo: (
                    seconds: number,
                    allowSeekAhead: boolean = true,
                    autoPlay: boolean = true
                ) => {
                    if (playerRef.current && typeof playerRef.current.seekTo === "function") {
                        try {
                            playerRef.current.seekTo(seconds, allowSeekAhead)
                            if (autoPlay && typeof playerRef.current.playVideo === "function") {
                                playerRef.current.playVideo()
                            }
                            onTimeUpdateRef.current?.(seconds)
                        } catch (err) {
                            console.warn("YouTube player seek failed:", err)
                        }
                    } else {
                        // Buffer seek until player onReady fires
                        pendingSeekRef.current = { seconds, autoPlay }
                    }
                },
                play: () => {
                    if (playerRef.current && typeof playerRef.current.playVideo === "function") {
                        playerRef.current.playVideo()
                    }
                },
                pause: () => {
                    if (playerRef.current && typeof playerRef.current.pauseVideo === "function") {
                        playerRef.current.pauseVideo()
                    }
                },
                getCurrentTime: () => {
                    return playerRef.current &&
                        typeof playerRef.current.getCurrentTime === "function"
                        ? playerRef.current.getCurrentTime()
                        : 0
                },
            }),
            []
        )

        // Initialize Player - ONLY when videoId changes
        useEffect(() => {
            let active = true
            setPlaybackError(null)
            setIsPlayerReady(false)

            const startTimeTracking = () => {
                if (timeIntervalRef.current) return
                timeIntervalRef.current = setInterval(() => {
                    if (
                        playerRef.current &&
                        typeof playerRef.current.getCurrentTime === "function"
                    ) {
                        try {
                            const time = playerRef.current.getCurrentTime()
                            if (typeof time === "number" && !Number.isNaN(time)) {
                                onTimeUpdateRef.current?.(time)
                            }
                        } catch {}
                    }
                }, 250)
            }

            const stopTimeTracking = () => {
                if (timeIntervalRef.current) {
                    clearInterval(timeIntervalRef.current)
                    timeIntervalRef.current = null
                }
            }

            const initPlayer = async () => {
                await loadYouTubeIframeApi()
                if (!active || !containerRef.current) return

                // Destroy existing player if any
                if (playerRef.current && typeof playerRef.current.destroy === "function") {
                    try {
                        playerRef.current.destroy()
                    } catch {}
                    playerRef.current = null
                }

                // Clean mount container
                containerRef.current.innerHTML = ""

                // Create fresh mount node for YouTube API replacement
                const mountDiv = document.createElement("div")
                mountDiv.className = "w-full h-full"
                containerRef.current.appendChild(mountDiv)

                try {
                    playerRef.current = new window.YT.Player(mountDiv, {
                        width: "100%",
                        height: "100%",
                        videoId,
                        playerVars: {
                            autoplay: 0,
                            controls: 1,
                            rel: 0,
                            modestbranding: 1,
                            playsinline: 1,
                            enablejsapi: 1,
                            origin: typeof window !== "undefined" ? window.location.origin : "",
                            cc_lang_pref: lang || "en",
                            cc_load_policy: 1,
                            hl: lang || "en",
                        },
                        events: {
                            onReady: () => {
                                if (!active) return
                                setIsPlayerReady(true)
                                onReadyRef.current?.()

                                // Set preferred captions track if API supports it
                                try {
                                    const inst = playerRef.current as unknown as {
                                        setOption?: (
                                            module: string,
                                            option: string,
                                            val: unknown
                                        ) => void
                                    }
                                    if (lang && typeof inst?.setOption === "function") {
                                        inst.setOption("captions", "track", { languageCode: lang })
                                    }
                                } catch {}

                                // Apply any buffered seek
                                if (pendingSeekRef.current !== null) {
                                    const { seconds, autoPlay } = pendingSeekRef.current
                                    pendingSeekRef.current = null
                                    try {
                                        playerRef.current?.seekTo(seconds, true)
                                        if (autoPlay) {
                                            playerRef.current?.playVideo()
                                        }
                                        onTimeUpdateRef.current?.(seconds)
                                    } catch {}
                                }
                            },
                            onStateChange: (event) => {
                                if (!active) return
                                const isPlaying = event.data === window.YT.PlayerState.PLAYING
                                onPlayStateChangeRef.current?.(isPlaying)
                                if (isPlaying) {
                                    startTimeTracking()
                                } else {
                                    stopTimeTracking()
                                }
                            },
                            onError: (event) => {
                                if (!active) return
                                stopTimeTracking()
                                // Code 101 or 150: Embed disabled by creator
                                // Code 100: Video removed or private
                                if (event.data === 101 || event.data === 150) {
                                    setPlaybackError(
                                        "Embedding is restricted by the video owner. However, transcript browsing and AI chat are fully operational!"
                                    )
                                } else if (event.data === 100) {
                                    setPlaybackError(
                                        "This video is unavailable, private, or has been deleted."
                                    )
                                } else {
                                    setPlaybackError("Could not initialize YouTube video player.")
                                }
                            },
                        },
                    })
                } catch (initErr) {
                    console.warn("Failed to instantiate YT.Player:", initErr)
                    setPlaybackError("Failed to initialize YouTube IFrame player.")
                }
            }

            void initPlayer()

            return () => {
                active = false
                stopTimeTracking()
                if (playerRef.current && typeof playerRef.current.destroy === "function") {
                    try {
                        playerRef.current.destroy()
                    } catch {}
                    playerRef.current = null
                }
            }
        }, [videoId, lang])

        return (
            <div
                className={`relative w-full aspect-video bg-black rounded-2xl overflow-hidden shadow-md shrink-0 ${className}`}
            >
                {/* Embed error notice */}
                {playbackError && (
                    <div className="absolute inset-0 z-20 flex flex-col items-center justify-center p-6 bg-black/90 text-center text-white">
                        <AlertCircleIcon size={32} className="text-amber-400 mb-3" />
                        <p className="text-sm font-semibold max-w-sm mb-2">{playbackError}</p>
                        <a
                            href={`https://www.youtube.com/watch?v=${videoId}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-600 hover:bg-red-700 text-white text-xs font-semibold transition-colors mt-2"
                        >
                            <PlayIcon size={13} />
                            <span>Watch on YouTube</span>
                        </a>
                    </div>
                )}

                {/* Loading skeleton */}
                {!isPlayerReady && !playbackError && (
                    <div className="absolute inset-0 z-10 flex items-center justify-center bg-[var(--surface-bg)] text-[var(--text-muted)]">
                        <div className="flex flex-col items-center gap-2">
                            <div className="w-8 h-8 rounded-full border-2 border-[var(--accent)] border-t-transparent animate-spin" />
                            <span className="text-xs font-medium">Loading video player...</span>
                        </div>
                    </div>
                )}

                {/* Container for YouTube API IFrame insertion: strict full-width/height styling */}
                <div
                    ref={containerRef}
                    className="w-full h-full [&_iframe]:!w-full [&_iframe]:!h-full [&_iframe]:!absolute [&_iframe]:!inset-0 [&_iframe]:!border-0"
                />
            </div>
        )
    })
)
