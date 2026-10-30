"use client"

import React, { useCallback, useEffect, useRef, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import {
    BookOpenIcon,
    CheckIcon,
    ChevronDownIcon,
    ChevronUpIcon,
    LinkIcon,
    MenuIcon,
    MessageSquareIcon,
    MoonIcon,
    PlayIcon,
    PlusIcon,
    RefreshCwIcon,
    SendIcon,
    SparklesIcon,
    StopIcon,
    SunIcon,
} from "./Icons"
import { MarkdownRenderer } from "./MarkdownRenderer"
import { PinLogin } from "./PinLogin"
import { Sidebar } from "./Sidebar"
import { Toast, type ToastMessage } from "./Toast"
import { YouTubePlayer, type YouTubePlayerRef } from "./YouTubePlayer"
import { YouTubeTranscriptPanel } from "./YouTubeTranscriptPanel"
import { YouTubeUrlEntry } from "./YouTubeUrlEntry"
import { AUTH_HEADER_NAME, AUTH_STORAGE_KEY, getAuthHeaders } from "@/lib/auth-client"
import {
    confirmYouTubeTranscription,
    fetchYouTubeVideoDetails,
    initYouTubeVideo,
    subscribeToVideoProgress,
} from "@/lib/youtube-client"
import { formatTimestamp } from "@/lib/youtube-chunker"
import { YOUTUBE_CHAT_CONFIG } from "@/lib/youtube-model-config"
import type {
    Citation,
    Conversation,
    Message,
    TranscriptSegment,
    YoutubeProgressEvent,
    YoutubeVideoItem,
} from "@/lib/types"

const YOUTUBE_SUGGESTED_PROMPTS = [
    "Summarize the key points and core takeaways of this video.",
    "What are the main arguments or topics discussed?",
    "Explain the conclusions or recommendations made by the speaker.",
]

export function YouTubeChatWorkspace() {
    const router = useRouter()
    // Authentication & App State
    const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null)
    const [theme, setTheme] = useState<"light" | "dark">("light")
    const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false)
    const [toasts, setToasts] = useState<ToastMessage[]>([])

    // Active Video & Conversation State
    const [video, setVideo] = useState<YoutubeVideoItem | null>(null)
    const [segments, setSegments] = useState<TranscriptSegment[]>([])
    const [currentTime, setCurrentTime] = useState<number>(0)
    const [conversations, setConversations] = useState<Conversation[]>([])
    const [activeConversationId, setActiveConversationId] = useState<string | undefined>(undefined)
    const [activeConversationTitle, setActiveConversationTitle] = useState<string>("")
    const [messages, setMessages] = useState<Message[]>([])

    // Processing & Loading State
    const [isProcessing, setIsProcessing] = useState(false)
    const [progressEvent, setProgressEvent] = useState<YoutubeProgressEvent | null>(null)
    const [errorMessage, setErrorMessage] = useState<string | null>(null)
    const [isLoadingDetails, setIsLoadingDetails] = useState(false)

    // Chat Streaming State
    const [chatInput, setChatInput] = useState("")
    const [isStreaming, setIsStreaming] = useState(false)
    const [streamingContent, setStreamingContent] = useState("")
    const [streamingReasoning, setStreamingReasoning] = useState("")
    const [streamingCitations, setStreamingCitations] = useState<Citation[]>([])
    const [isReasoningOpen, setIsReasoningOpen] = useState(false)
    const [copiedLink, setCopiedLink] = useState(false)

    // Mobile layout tab: "player" or "chat"
    const [mobileTab, setMobileTab] = useState<"player" | "chat">("player")

    // Refs
    const playerRef = useRef<YouTubePlayerRef>(null)
    const chatScrollContainerRef = useRef<HTMLDivElement>(null)
    const abortControllerRef = useRef<AbortController | null>(null)
    const progressCleanupRef = useRef<(() => void) | null>(null)

    // Cleanup progress subscription on unmount
    useEffect(() => {
        return () => {
            if (progressCleanupRef.current) {
                progressCleanupRef.current()
            }
        }
    }, [])

    // Toast helpers
    const addToast = useCallback((message: string, isError: boolean = false) => {
        const id = crypto.randomUUID()
        setToasts((prev) => [...prev, { id, message, isError }])
    }, [])

    const dismissToast = useCallback((id: string) => {
        setToasts((prev) => prev.filter((t) => t.id !== id))
    }, [])

    // Check PIN Authentication
    useEffect(() => {
        const savedPin =
            typeof window !== "undefined" ? localStorage.getItem(AUTH_STORAGE_KEY) : null
        if (savedPin && savedPin.trim().length === 4) {
            setIsAuthenticated(true)
            fetch("/api/auth/verify", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    [AUTH_HEADER_NAME]: savedPin.trim(),
                },
                body: JSON.stringify({ pin: savedPin.trim() }),
            })
                .then((res) => {
                    if (!res.ok) {
                        localStorage.removeItem(AUTH_STORAGE_KEY)
                        setIsAuthenticated(false)
                    }
                })
                .catch(() => {})
        } else {
            setIsAuthenticated(false)
        }
    }, [])

    // Initialize Theme
    useEffect(() => {
        const savedTheme = localStorage.getItem("cf_ai_theme") as "light" | "dark" | null
        const initialTheme =
            savedTheme ||
            (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
        setTheme(initialTheme)
        document.documentElement.classList.toggle("dark", initialTheme === "dark")
    }, [])

    const toggleTheme = () => {
        const newTheme = theme === "light" ? "dark" : "light"
        setTheme(newTheme)
        localStorage.setItem("cf_ai_theme", newTheme)
        document.documentElement.classList.toggle("dark", newTheme === "dark")
    }

    // Load only YouTube Conversations for the Sidebar
    const loadConversations = useCallback(async () => {
        if (!isAuthenticated) return
        try {
            const res = await fetch("/api/conversations?type=youtube", {
                headers: getAuthHeaders(),
            })
            if (res.ok) {
                const data = (await res.json()) as Conversation[]
                setConversations(Array.isArray(data) ? data : [])
            }
        } catch (err) {
            console.warn("Failed to load YouTube conversations:", err)
        }
    }, [isAuthenticated])

    useEffect(() => {
        if (isAuthenticated) {
            loadConversations()
        }
    }, [isAuthenticated, loadConversations])

    // Update URL query string
    const updateUrlId = useCallback((id?: string) => {
        if (typeof window === "undefined") return
        const url = new URL(window.location.href)
        if (id) {
            url.searchParams.set("id", id)
        } else {
            url.searchParams.delete("id")
        }
        window.history.pushState({}, "", url.toString())
    }, [])

    // Load Video Details
    const loadVideoAndSegments = useCallback(
        async (videoId: string) => {
            try {
                setIsLoadingDetails(true)
                const data = await fetchYouTubeVideoDetails(videoId)
                setVideo(data.video)
                setSegments(data.segments || [])
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : "Failed to load video details"
                addToast(msg, true)
            } finally {
                setIsLoadingDetails(false)
            }
        },
        [addToast]
    )

    // Load existing conversation by ID from URL ?id=...
    const loadConversationById = useCallback(
        async (convId: string) => {
            try {
                setIsLoadingDetails(true)
                const res = await fetch(`/api/conversations/${convId}`, {
                    headers: getAuthHeaders(),
                })
                if (!res.ok) {
                    if (res.status === 404) {
                        addToast("YouTube conversation not found.", true)
                        updateUrlId(undefined)
                        setActiveConversationId(undefined)
                    }
                    return
                }

                const data = (await res.json()) as Conversation & {
                    type?: string
                    video_id?: string
                }
                // Verify conversation type
                if (data.type && data.type !== "youtube") {
                    addToast("Cannot open PDF chat in YouTube workspace. Redirecting...", true)
                    updateUrlId(undefined)
                    setActiveConversationId(undefined)
                    return
                }

                setActiveConversationId(convId)
                setActiveConversationTitle(data.title || "YouTube Chat")
                setMessages(Array.isArray(data.messages) ? data.messages : [])

                // Load associated video
                if (data.video_id) {
                    await loadVideoAndSegments(data.video_id)
                }
            } catch (err: unknown) {
                console.warn("Failed to load conversation:", err)
            } finally {
                setIsLoadingDetails(false)
            }
        },
        [addToast, updateUrlId, loadVideoAndSegments]
    )

    // Handle initial URL ?id= param
    useEffect(() => {
        if (!isAuthenticated) return
        const urlParams = new URLSearchParams(window.location.search)
        const idParam = urlParams.get("id")
        if (idParam) {
            loadConversationById(idParam)
        }
    }, [isAuthenticated, loadConversationById])

    // Submit YouTube URL handler
    const handleSubmitUrl = async (canonicalUrl: string) => {
        try {
            setIsProcessing(true)
            setErrorMessage(null)
            setProgressEvent(null)

            const initRes = await initYouTubeVideo(canonicalUrl)

            if (initRes.isReady && initRes.videoId) {
                // Video is already processed and ready
                await loadVideoAndSegments(initRes.videoId)
                setIsProcessing(false)
                addToast("Video knowledge index loaded from cache!")
                return
            }

            // Cancel any previous SSE subscription
            if (progressCleanupRef.current) {
                progressCleanupRef.current()
            }

            // Start SSE progress tracking
            progressCleanupRef.current = subscribeToVideoProgress(initRes.videoId, {
                onProgress: (ev) => {
                    setProgressEvent(ev)
                },
                onAwaitingConfirmation: (ev) => {
                    setProgressEvent(ev)
                    setIsProcessing(false)
                },
                onReady: async (ev) => {
                    setProgressEvent(ev)
                    setIsProcessing(false)
                    addToast("Video indexed successfully!")
                    await loadVideoAndSegments(initRes.videoId)
                },
                onFailed: (ev) => {
                    setProgressEvent(ev)
                    setIsProcessing(false)
                    setErrorMessage(ev.error || "Video processing failed.")
                },
                onError: (err) => {
                    console.warn("SSE stream warning:", err)
                },
            })
        } catch (err: unknown) {
            setIsProcessing(false)
            const msg = err instanceof Error ? err.message : "Failed to process video URL"
            setErrorMessage(msg)
            addToast(msg, true)
        }
    }

    // Explicit AI Transcription Confirmation Handler
    const handleConfirmAiTranscription = async (videoId: string, confirmed: boolean) => {
        try {
            setIsProcessing(true)
            await confirmYouTubeTranscription(videoId, confirmed)

            if (!confirmed) {
                setIsProcessing(false)
                setErrorMessage("Transcription declined.")
                return
            }

            // Re-subscribe to progress
            subscribeToVideoProgress(videoId, {
                onProgress: (ev) => setProgressEvent(ev),
                onReady: async (ev) => {
                    setProgressEvent(ev)
                    setIsProcessing(false)
                    addToast("AI transcription & indexing completed!")
                    await loadVideoAndSegments(videoId)
                },
                onFailed: (ev) => {
                    setProgressEvent(ev)
                    setIsProcessing(false)
                    setErrorMessage(ev.error || "AI transcription failed.")
                },
            })
        } catch (err: unknown) {
            setIsProcessing(false)
            const msg = err instanceof Error ? err.message : "Confirmation failed"
            setErrorMessage(msg)
            addToast(msg, true)
        }
    }

    // Time update callback from video player
    const handleTimeUpdate = useCallback((sec: number) => {
        setCurrentTime(sec)
    }, [])

    // Seek player, start autoplay from timestamp, and sync transcript highlight
    const handleSeek = useCallback((seconds: number) => {
        if (!Number.isFinite(seconds) || seconds < 0) return
        playerRef.current?.seekTo(seconds, true, true)
        setCurrentTime(seconds)
        setMobileTab("player")
    }, [])

    // Start a new chat for the current video
    const handleNewChatForVideo = () => {
        setActiveConversationId(undefined)
        setActiveConversationTitle("")
        setMessages([])
        updateUrlId(undefined)
        addToast("Started new chat for this video.")
    }

    // Switch video: go back to URL entry
    const handleSwitchVideo = () => {
        setVideo(null)
        setSegments([])
        setActiveConversationId(undefined)
        setActiveConversationTitle("")
        setMessages([])
        setProgressEvent(null)
        setErrorMessage(null)
        updateUrlId(undefined)
    }

    // Copy chat share link
    const handleCopyChatLink = async () => {
        if (!activeConversationId || typeof window === "undefined") return
        const url = new URL(window.location.origin + window.location.pathname)
        url.searchParams.set("id", activeConversationId)
        try {
            await navigator.clipboard.writeText(url.toString())
            setCopiedLink(true)
            setTimeout(() => setCopiedLink(false), 2000)
            addToast("Chat link copied to clipboard!")
        } catch {
            addToast("Failed to copy link", true)
        }
    }

    // Send chat message
    const handleSendMessage = async (promptToSend?: string) => {
        const text = (promptToSend || chatInput).trim()
        if (!text || isStreaming || !video) return

        setChatInput("")
        setIsStreaming(true)
        setStreamingContent("")
        setStreamingReasoning("")
        setStreamingCitations([])

        // Optimistically add user message
        const tempUserMsg: Message = {
            id: crypto.randomUUID(),
            conversation_id: activeConversationId || "",
            role: "user",
            content: text,
            model: YOUTUBE_CHAT_CONFIG.modelId,
            created_at: Date.now(),
        }
        setMessages((prev) => [...prev, tempUserMsg])

        // Auto-scroll to bottom
        setTimeout(() => {
            chatScrollContainerRef.current?.scrollTo({
                top: chatScrollContainerRef.current.scrollHeight,
                behavior: "smooth",
            })
        }, 50)

        const controller = new AbortController()
        abortControllerRef.current = controller

        try {
            const res = await fetch("/api/youtube/chat", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    ...getAuthHeaders(),
                },
                body: JSON.stringify({
                    conversationId: activeConversationId,
                    videoId: video.id,
                    message: text,
                    effort: YOUTUBE_CHAT_CONFIG.defaultEffort,
                }),
                signal: controller.signal,
            })

            if (!res.ok) {
                const errData = (await res.json().catch(() => ({}))) as { error?: string }
                throw new Error(errData.error || `HTTP ${res.status}`)
            }

            if (!res.body) {
                throw new Error("No response body received from server.")
            }

            const reader = res.body.getReader()
            const decoder = new TextDecoder()
            let buffer = ""
            let fullText = ""
            let fullReasoning = ""
            let citations: Citation[] = []
            let newConvId = activeConversationId

            while (true) {
                const { done, value } = await reader.read()
                if (done) break

                buffer += decoder.decode(value, { stream: true })
                const parts = buffer.split("\n\n")
                buffer = parts.pop() || ""

                for (const part of parts) {
                    const lines = part.split("\n")
                    for (const line of lines) {
                        const trimmed = line.trim()
                        if (!trimmed || !trimmed.startsWith("data:")) continue
                        const dataStr = trimmed.slice(5).trim()
                        if (dataStr === "[DONE]") continue

                        try {
                            const parsed = JSON.parse(dataStr) as {
                                delta?: string
                                reasoning?: string
                                conversationId?: string
                                type?: string
                                citations?: Citation[]
                                done?: boolean
                                messageId?: string
                                error?: string
                            }

                            if (parsed.error) {
                                throw new Error(parsed.error)
                            }

                            if (parsed.conversationId && !newConvId) {
                                newConvId = parsed.conversationId
                                setActiveConversationId(newConvId)
                                updateUrlId(newConvId)
                                loadConversations()
                            }

                            if (parsed.type === "citations" && Array.isArray(parsed.citations)) {
                                citations = parsed.citations
                                setStreamingCitations(citations)
                            }

                            if (parsed.reasoning) {
                                fullReasoning += parsed.reasoning
                                setStreamingReasoning(fullReasoning)
                            }

                            if (parsed.delta) {
                                fullText += parsed.delta
                                setStreamingContent(fullText)
                            }
                        } catch {
                            // Ignore partial JSON chunks
                        }
                    }
                }
            }

            // Stream completed: finalize message in state
            const finalAssistantMsg: Message = {
                id: crypto.randomUUID(),
                conversation_id: newConvId || "",
                role: "assistant",
                content: fullText,
                model: YOUTUBE_CHAT_CONFIG.modelId,
                reasoning: fullReasoning || null,
                citations: citations.length > 0 ? citations : null,
                created_at: Date.now(),
            }

            setMessages((prev) => [...prev, finalAssistantMsg])
            setStreamingContent("")
            setStreamingReasoning("")
            setStreamingCitations([])
            loadConversations()
        } catch (err: unknown) {
            const isAbort = err instanceof Error && err.name === "AbortError"
            if (!isAbort) {
                const msg = err instanceof Error ? err.message : "Error streaming answer"
                addToast(msg, true)
            }
        } finally {
            setIsStreaming(false)
            abortControllerRef.current = null
        }
    }

    const handleStopStreaming = () => {
        if (abortControllerRef.current) {
            abortControllerRef.current.abort()
            abortControllerRef.current = null
            setIsStreaming(false)
        }
    }

    // If waiting for PIN authentication
    if (isAuthenticated === false) {
        return <PinLogin onSuccess={() => setIsAuthenticated(true)} />
    }

    return (
        <div className="flex h-dvh w-screen overflow-hidden bg-[var(--background)] text-[var(--text-primary)] font-sans antialiased">
            {/* Sidebar with YouTube chats only */}
            <Sidebar
                conversations={conversations}
                activeConversationId={activeConversationId}
                onSelectConversation={(id) => {
                    loadConversationById(id)
                    updateUrlId(id)
                }}
                onNewChat={() => {
                    if (video) {
                        handleNewChatForVideo()
                    } else {
                        handleSwitchVideo()
                    }
                }}
                onRenameConversation={async (id, newTitle) => {
                    await fetch(`/api/conversations/${id}`, {
                        method: "PATCH",
                        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
                        body: JSON.stringify({ title: newTitle }),
                    })
                    loadConversations()
                }}
                onDeleteConversation={async (id) => {
                    await fetch(`/api/conversations/${id}`, {
                        method: "DELETE",
                        headers: getAuthHeaders(),
                    })
                    if (id === activeConversationId) {
                        handleSwitchVideo()
                    }
                    loadConversations()
                }}
                onCopyLink={handleCopyChatLink}
                onOpenKnowledgeBase={() => {
                    router.push("/")
                }}
                isOpenMobile={isMobileSidebarOpen}
                onCloseMobile={() => setIsMobileSidebarOpen(false)}
                theme={theme}
                onToggleTheme={toggleTheme}
            />

            {/* Main Application Area */}
            <div className="flex-1 flex flex-col h-full overflow-hidden">
                {/* Workspace Header */}
                <header className="h-14 px-4 border-b border-[var(--border)] bg-[var(--surface-bg)] flex items-center justify-between shrink-0">
                    <div className="flex items-center gap-3">
                        <button
                            type="button"
                            onClick={() => setIsMobileSidebarOpen(true)}
                            className="md:hidden p-2 rounded-xl text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--button-hover)]"
                            aria-label="Open sidebar"
                        >
                            <MenuIcon size={18} />
                        </button>

                        {/* Back to Document Chat Button */}
                        <Link
                            href="/"
                            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl text-xs font-semibold text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--button-hover)] border border-[var(--border)] transition-colors"
                            title="Switch to Documents & PDF Chat"
                        >
                            <BookOpenIcon size={14} />
                            <span className="hidden sm:inline">Documents</span>
                        </Link>

                        {/* Video Title Header */}
                        {video && (
                            <div className="flex items-center gap-2 max-w-[260px] sm:max-w-md md:max-w-lg truncate">
                                <span className="inline-flex items-center gap-1 font-mono text-[10px] font-bold px-1.5 py-0.5 rounded bg-red-600 text-white shrink-0">
                                    <PlayIcon size={9} />
                                    <span>YOUTUBE</span>
                                </span>
                                <div className="flex items-center gap-1.5 truncate">
                                    <span
                                        className="text-xs sm:text-sm font-semibold truncate text-[var(--text-primary)]"
                                        title={video.title}
                                    >
                                        {video.title}
                                    </span>
                                    {activeConversationTitle && (
                                        <span className="hidden md:inline-flex items-center gap-1 text-xs text-[var(--text-muted)] truncate font-normal">
                                            <span>—</span>
                                            <span className="truncate">
                                                {activeConversationTitle}
                                            </span>
                                        </span>
                                    )}
                                </div>
                                {isLoadingDetails && (
                                    <RefreshCwIcon
                                        size={12}
                                        className="animate-spin text-[var(--text-muted)] shrink-0"
                                    />
                                )}
                            </div>
                        )}
                    </div>

                    {/* Actions Right */}
                    <div className="flex items-center gap-2">
                        {video && (
                            <>
                                <button
                                    type="button"
                                    onClick={handleNewChatForVideo}
                                    className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold bg-[var(--surface-bg)] hover:bg-[var(--button-hover)] border border-[var(--border)] text-[var(--text-primary)] transition-colors"
                                    title="Start a new chat for this video"
                                >
                                    <PlusIcon size={13} className="text-red-500" />
                                    <span>New Chat</span>
                                </button>

                                <button
                                    type="button"
                                    onClick={handleSwitchVideo}
                                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--button-hover)] transition-colors"
                                    title="Load a different video URL"
                                >
                                    <RefreshCwIcon size={13} />
                                    <span className="hidden sm:inline">Change Video</span>
                                </button>

                                {activeConversationId && (
                                    <button
                                        type="button"
                                        onClick={handleCopyChatLink}
                                        className="p-1.5 rounded-xl text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--button-hover)] transition-colors"
                                        title={
                                            copiedLink
                                                ? "Copied!"
                                                : "Copy link to this YouTube chat"
                                        }
                                    >
                                        {copiedLink ? (
                                            <CheckIcon size={15} className="text-emerald-500" />
                                        ) : (
                                            <LinkIcon size={15} />
                                        )}
                                    </button>
                                )}
                            </>
                        )}

                        <button
                            type="button"
                            onClick={toggleTheme}
                            className="p-2 rounded-xl text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--button-hover)] transition-colors"
                            title={`Switch to ${theme === "light" ? "dark" : "light"} mode`}
                        >
                            {theme === "light" ? <MoonIcon size={16} /> : <SunIcon size={16} />}
                        </button>
                    </div>
                </header>

                {/* Body Content */}
                {!video ? (
                    // Initial route / no video loaded: render YouTube URL submission
                    <YouTubeUrlEntry
                        onSubmitUrl={handleSubmitUrl}
                        onConfirmAiTranscription={handleConfirmAiTranscription}
                        isProcessing={isProcessing}
                        progressEvent={progressEvent}
                        errorMessage={errorMessage}
                        onRetry={() => {
                            setErrorMessage(null)
                            setIsProcessing(false)
                        }}
                    />
                ) : (
                    // Video Workspace: Video Player + Transcript + Chat
                    <div className="flex-1 flex flex-col md:flex-row h-full overflow-hidden">
                        {/* Mobile Tab Switcher */}
                        <div className="md:hidden flex border-b border-[var(--border)] bg-[var(--surface-bg)] text-xs font-semibold">
                            <button
                                type="button"
                                onClick={() => setMobileTab("player")}
                                className={`flex-1 py-2 text-center border-b-2 transition-colors ${
                                    mobileTab === "player"
                                        ? "border-red-500 text-red-500 font-bold"
                                        : "border-transparent text-[var(--text-muted)]"
                                }`}
                            >
                                Video & Transcript
                            </button>
                            <button
                                type="button"
                                onClick={() => setMobileTab("chat")}
                                className={`flex-1 py-2 text-center border-b-2 transition-colors ${
                                    mobileTab === "chat"
                                        ? "border-red-500 text-red-500 font-bold"
                                        : "border-transparent text-[var(--text-muted)]"
                                }`}
                            >
                                Chat ({messages.length})
                            </button>
                        </div>

                        {/* Left / Top Column: Video Player & Synchronized Transcript */}
                        <div
                            className={`w-full md:w-[48%] lg:w-[50%] h-full flex flex-col p-3 md:p-4 gap-3 border-r border-[var(--border)] overflow-hidden shrink-0 ${
                                mobileTab === "chat" ? "hidden md:flex" : "flex"
                            }`}
                        >
                            {/* Embedded YouTube Player */}
                            <YouTubePlayer
                                ref={playerRef}
                                videoId={video.id}
                                lang={video.transcript_lang || segments[0]?.lang || "en"}
                                onTimeUpdate={handleTimeUpdate}
                            />

                            {/* Synchronized Transcript Panel */}
                            <div className="flex-1 min-h-0 overflow-hidden">
                                <YouTubeTranscriptPanel
                                    segments={segments}
                                    currentTime={currentTime}
                                    onSeek={handleSeek}
                                    lang={video.transcript_lang || segments[0]?.lang}
                                    className="h-full"
                                />
                            </div>
                        </div>

                        {/* Right / Bottom Column: Grounded AI Chat */}
                        <div
                            className={`flex-1 flex flex-col h-full min-h-0 overflow-hidden bg-[var(--background)] ${
                                mobileTab === "player" ? "hidden md:flex" : "flex"
                            }`}
                        >
                            {/* Messages Scroll Area */}
                            <div
                                ref={chatScrollContainerRef}
                                className="flex-1 overflow-y-auto p-4 space-y-4 custom-scrollbar"
                            >
                                {messages.length === 0 && !isStreaming ? (
                                    <div className="h-full flex flex-col items-center justify-center text-center p-6 text-[var(--text-muted)]">
                                        <div className="w-10 h-10 rounded-2xl bg-red-600/10 text-red-500 flex items-center justify-center mb-3">
                                            <MessageSquareIcon size={20} />
                                        </div>
                                        <h3 className="font-semibold text-sm text-[var(--text-primary)] mb-1">
                                            Ask anything about this video
                                        </h3>
                                        <p className="text-xs max-w-sm mb-6 leading-relaxed">
                                            Answers are grounded in the verified transcript excerpts
                                            with clickable timestamps that seek the video.
                                        </p>

                                        {/* Suggested Questions */}
                                        <div className="flex flex-col gap-2 w-full max-w-md">
                                            {YOUTUBE_SUGGESTED_PROMPTS.map((q) => (
                                                <button
                                                    key={q}
                                                    type="button"
                                                    onClick={() => handleSendMessage(q)}
                                                    className="p-3 text-left rounded-xl bg-[var(--surface-bg)] hover:bg-[var(--button-hover)] border border-[var(--border)] text-xs text-[var(--text-primary)] transition-all cursor-pointer group"
                                                >
                                                    <span className="group-hover:text-red-500 transition-colors">
                                                        {q}
                                                    </span>
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                ) : (
                                    <>
                                        {messages.map((m) => (
                                            <div
                                                key={m.id}
                                                className={`flex flex-col ${
                                                    m.role === "user" ? "items-end" : "items-start"
                                                }`}
                                            >
                                                {m.role === "user" ? (
                                                    <div className="max-w-[85%] rounded-2xl px-4 py-2.5 bg-[var(--accent)] text-white text-xs sm:text-sm font-medium leading-relaxed shadow-xs">
                                                        {m.content}
                                                    </div>
                                                ) : (
                                                    <div className="max-w-[92%] flex flex-col gap-2 rounded-2xl p-4 bg-[var(--surface-bg)] border border-[var(--border)] text-xs sm:text-sm shadow-xs">
                                                        {/* DeepSeek R1 Reasoning Accordion */}
                                                        {m.reasoning && (
                                                            <div className="border border-[var(--border)] rounded-xl overflow-hidden text-xs">
                                                                <button
                                                                    type="button"
                                                                    onClick={() =>
                                                                        setIsReasoningOpen(
                                                                            (prev) => !prev
                                                                        )
                                                                    }
                                                                    className="w-full flex items-center justify-between px-3 py-2 bg-[var(--button-hover)] text-[var(--text-muted)] font-mono text-[11px] font-semibold"
                                                                >
                                                                    <div className="flex items-center gap-1.5">
                                                                        <SparklesIcon
                                                                            size={12}
                                                                            className="text-amber-500"
                                                                        />
                                                                        <span>
                                                                            DeepSeek R1 Thinking
                                                                            Trace
                                                                        </span>
                                                                    </div>
                                                                    {isReasoningOpen ? (
                                                                        <ChevronUpIcon size={14} />
                                                                    ) : (
                                                                        <ChevronDownIcon
                                                                            size={14}
                                                                        />
                                                                    )}
                                                                </button>
                                                                {isReasoningOpen && (
                                                                    <div className="p-3 bg-[var(--input-bg)] text-[var(--text-muted)] font-mono text-[11px] leading-relaxed whitespace-pre-wrap max-h-60 overflow-y-auto">
                                                                        {m.reasoning}
                                                                    </div>
                                                                )}
                                                            </div>
                                                        )}

                                                        {/* Assistant Markdown Content */}
                                                        <MarkdownRenderer
                                                            content={m.content}
                                                            onSeek={handleSeek}
                                                        />

                                                        {/* Clickable Grounded Citation Pills */}
                                                        {m.citations && m.citations.length > 0 && (
                                                            <div className="mt-2 pt-2 border-t border-[var(--border)] flex flex-wrap items-center gap-1.5">
                                                                <span className="text-[10px] uppercase font-mono font-bold text-[var(--text-muted)] tracking-wider mr-1">
                                                                    Sources:
                                                                </span>
                                                                {m.citations.map((c, i) => (
                                                                    <button
                                                                        key={c.id || i}
                                                                        type="button"
                                                                        onClick={() =>
                                                                            handleSeek(
                                                                                c.startSeconds
                                                                            )
                                                                        }
                                                                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md font-mono text-[11px] bg-[var(--badge-bg)] hover:bg-[var(--button-hover)] text-[var(--accent)] border border-[var(--border)] transition-colors cursor-pointer"
                                                                        title={`Jump to video at ${formatTimestamp(c.startSeconds)}`}
                                                                    >
                                                                        <PlayIcon size={9} />
                                                                        <span>
                                                                            {formatTimestamp(
                                                                                c.startSeconds
                                                                            )}{" "}
                                                                            -{" "}
                                                                            {formatTimestamp(
                                                                                c.endSeconds
                                                                            )}
                                                                        </span>
                                                                    </button>
                                                                ))}
                                                            </div>
                                                        )}
                                                    </div>
                                                )}
                                            </div>
                                        ))}

                                        {/* Streaming Active Response */}
                                        {isStreaming && (
                                            <div className="max-w-[92%] flex flex-col gap-2 rounded-2xl p-4 bg-[var(--surface-bg)] border border-[var(--border)] text-xs sm:text-sm shadow-xs">
                                                {streamingReasoning && (
                                                    <div className="border border-[var(--border)] rounded-xl overflow-hidden text-xs mb-2">
                                                        <div className="flex items-center gap-1.5 px-3 py-1.5 bg-[var(--button-hover)] text-[var(--text-muted)] font-mono text-[11px] font-semibold">
                                                            <SparklesIcon
                                                                size={12}
                                                                className="text-amber-500 animate-pulse"
                                                            />
                                                            <span>DeepSeek R1 Thinking...</span>
                                                        </div>
                                                        <div className="p-3 bg-[var(--input-bg)] text-[var(--text-muted)] font-mono text-[11px] leading-relaxed whitespace-pre-wrap max-h-40 overflow-y-auto">
                                                            {streamingReasoning}
                                                        </div>
                                                    </div>
                                                )}

                                                <MarkdownRenderer
                                                    content={
                                                        streamingContent ||
                                                        "Analyzing video transcript..."
                                                    }
                                                    onSeek={handleSeek}
                                                />

                                                {streamingCitations.length > 0 && (
                                                    <div className="mt-2 pt-2 border-t border-[var(--border)] flex flex-wrap items-center gap-1.5">
                                                        <span className="text-[10px] uppercase font-mono font-bold text-[var(--text-muted)] tracking-wider mr-1">
                                                            Sources:
                                                        </span>
                                                        {streamingCitations.map((c, i) => (
                                                            <button
                                                                key={c.id || i}
                                                                type="button"
                                                                onClick={() =>
                                                                    handleSeek(c.startSeconds)
                                                                }
                                                                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md font-mono text-[11px] bg-[var(--badge-bg)] text-[var(--accent)] border border-[var(--border)] cursor-pointer"
                                                            >
                                                                <PlayIcon size={9} />
                                                                <span>
                                                                    {formatTimestamp(
                                                                        c.startSeconds
                                                                    )}
                                                                </span>
                                                            </button>
                                                        ))}
                                                    </div>
                                                )}
                                            </div>
                                        )}
                                    </>
                                )}
                            </div>

                            {/* Chat Composer Bottom */}
                            <div className="p-3 md:p-4 border-t border-[var(--border)] bg-[var(--surface-bg)]">
                                <form
                                    onSubmit={(e) => {
                                        e.preventDefault()
                                        handleSendMessage()
                                    }}
                                    className="relative flex items-center"
                                >
                                    <input
                                        type="text"
                                        value={chatInput}
                                        onChange={(e) => setChatInput(e.target.value)}
                                        placeholder={`Ask about "${video.title}"...`}
                                        disabled={isStreaming}
                                        className="w-full pl-4 pr-20 py-3 rounded-xl text-xs sm:text-sm bg-[var(--input-bg)] border border-[var(--border)] text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:ring-1 focus:ring-red-500 transition-all"
                                    />

                                    <div className="absolute right-2 flex items-center gap-1">
                                        {isStreaming ? (
                                            <button
                                                type="button"
                                                onClick={handleStopStreaming}
                                                className="p-2 rounded-lg bg-red-500/10 text-red-500 hover:bg-red-500/20 transition-colors cursor-pointer"
                                                title="Stop generating"
                                            >
                                                <StopIcon size={14} />
                                            </button>
                                        ) : (
                                            <button
                                                type="submit"
                                                disabled={!chatInput.trim()}
                                                className="p-2 rounded-lg bg-red-600 hover:bg-red-700 disabled:opacity-40 text-white transition-colors cursor-pointer"
                                                title="Send message"
                                            >
                                                <SendIcon size={14} />
                                            </button>
                                        )}
                                    </div>
                                </form>
                            </div>
                        </div>
                    </div>
                )}
            </div>

            {/* Toasts */}
            <Toast toasts={toasts} onDismiss={dismissToast} />
        </div>
    )
}
