"use client"

import React, { useState, useEffect, useRef, useCallback } from "react"
import { Attachment, ContextMode, Conversation, EffortLevel, Message, ModelInfo } from "@/lib/types"
import { DEFAULT_MODEL_ID, MODELS } from "@/lib/models"
import { Sidebar } from "./Sidebar"
import { ChatMessage } from "./ChatMessage"
import { ChatComposer } from "./ChatComposer"
import { KnowledgeBaseModal } from "./KnowledgeBaseModal"
import { UsageModal } from "./UsageModal"
import { PinLogin } from "./PinLogin"
import { Toast, ToastMessage } from "./Toast"
import {
    ActivityIcon,
    ArrowDownIcon,
    BookOpenIcon,
    CheckIcon,
    LinkIcon,
    LockIcon,
    MenuIcon,
    SparklesIcon,
} from "./Icons"
import { AUTH_HEADER_NAME, AUTH_STORAGE_KEY, getAuthHeaders } from "@/lib/auth-client"
import { DailyUsageSummary } from "@/lib/db"

const SUGGESTED_PROMPTS = [
    {
        title: "Quantum Tunneling Explained",
        prompt: "Explain the physics of quantum tunneling using an intuitive analogy and its real-world semiconductor applications.",
    },
    {
        title: "Cloudflare Serverless Architecture",
        prompt: "How can I architect a globally distributed web application using Cloudflare Workers, D1, R2, and Vectorize?",
    },
    {
        title: "TypeScript Debounce Utility",
        prompt: "Write a strict TypeScript implementation of a debounce function that supports cancellation, immediate execution, and pending status.",
    },
]

export function ChatContainer() {
    const [conversations, setConversations] = useState<Conversation[]>([])
    const [activeConversationId, setActiveConversationId] = useState<string | undefined>(undefined)
    const [activeConversationTitle, setActiveConversationTitle] = useState<string>("")
    const [isLoadingConversation, setIsLoadingConversation] = useState(false)
    const [copiedLink, setCopiedLink] = useState(false)
    const activeConversationIdRef = useRef<string | undefined>(undefined)
    activeConversationIdRef.current = activeConversationId

    const [messages, setMessages] = useState<Message[]>([])
    const [models, setModels] = useState<ModelInfo[]>(MODELS)
    const [selectedModel, setSelectedModel] = useState<string>(DEFAULT_MODEL_ID)
    const [contextMode, setContextMode] = useState<ContextMode>("conversation")
    const [effort, setEffort] = useState<EffortLevel>("medium")

    const [isStreaming, setIsStreaming] = useState(false)
    const [streamingContent, setStreamingContent] = useState("")
    const [streamingReasoning, setStreamingReasoning] = useState("")
    const [userScrolledUp, setUserScrolledUp] = useState(false)

    const [isKnowledgeBaseOpen, setIsKnowledgeBaseOpen] = useState(false)
    const [isUsageOpen, setIsUsageOpen] = useState(false)
    const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false)
    const [theme, setTheme] = useState<"light" | "dark">("light")
    const [toasts, setToasts] = useState<ToastMessage[]>([])
    const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null)
    const [usageSummary, setUsageSummary] = useState<DailyUsageSummary | null>(null)

    const fetchUsageMetrics = useCallback(async () => {
        try {
            const res = await fetch("/api/usage", { headers: getAuthHeaders() })
            if (res.ok) {
                const data = (await res.json()) as { currentUsage?: DailyUsageSummary }
                if (data?.currentUsage) {
                    setUsageSummary(data.currentUsage)
                }
            }
        } catch {
            // ignore
        }
    }, [])

    const abortControllerRef = useRef<AbortController | null>(null)
    const chatScrollContainerRef = useRef<HTMLDivElement>(null)

    // Helper to add toast
    const addToast = useCallback((message: string, isError: boolean = false) => {
        const id = crypto.randomUUID()
        setToasts((prev) => [...prev, { id, message, isError }])
    }, [])

    const dismissToast = useCallback((id: string) => {
        setToasts((prev) => prev.filter((t) => t.id !== id))
    }, [])

    // Check PIN authentication from localStorage on initial mount
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
                .catch(() => {
                    // Keep optimistic authentication on network failure
                })
        } else {
            setIsAuthenticated(false)
        }
    }, [])

    // Fetch usage metrics whenever user is authenticated or usage modal closes
    useEffect(() => {
        if (isAuthenticated) {
            fetchUsageMetrics()
        }
    }, [isAuthenticated, isUsageOpen, fetchUsageMetrics])

    // Initialize theme from localStorage or system preference
    useEffect(() => {
        const savedTheme = localStorage.getItem("cf_ai_theme") as "light" | "dark" | null
        const initialTheme =
            savedTheme ||
            (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
        setTheme(initialTheme)
        document.documentElement.classList.toggle("dark", initialTheme === "dark")

        // Load persisted preferences
        const savedModel = localStorage.getItem("cf_ai_model")
        if (savedModel) setSelectedModel(savedModel)

        const savedContext = localStorage.getItem("cf_ai_context") as ContextMode | null
        if (savedContext) setContextMode(savedContext)

        const savedEffort = localStorage.getItem("cf_ai_effort") as EffortLevel | null
        if (savedEffort) setEffort(savedEffort)
    }, [])

    const toggleTheme = () => {
        const newTheme = theme === "light" ? "dark" : "light"
        setTheme(newTheme)
        localStorage.setItem("cf_ai_theme", newTheme)
        document.documentElement.classList.toggle("dark", newTheme === "dark")
    }

    // Persist selections
    const handleSelectModel = (id: string) => {
        setSelectedModel(id)
        localStorage.setItem("cf_ai_model", id)
        const m = models.find((item) => item.id === id)
        if (m?.supportsVision) {
            fetch("/api/models/agree", {
                method: "POST",
                headers: getAuthHeaders({ "Content-Type": "application/json" }),
                body: JSON.stringify({ model: id }),
            }).catch(() => {})
        }
    }

    const handleChangeContextMode = (mode: ContextMode) => {
        setContextMode(mode)
        localStorage.setItem("cf_ai_context", mode)
    }

    const handleChangeEffort = (level: EffortLevel) => {
        setEffort(level)
        localStorage.setItem("cf_ai_effort", level)
    }

    // Fetch model catalog when authenticated
    useEffect(() => {
        if (!isAuthenticated) return
        fetch("/api/models", { headers: getAuthHeaders() })
            .then((res) => (res.ok ? res.json() : null))
            .then((data: any) => {
                if (data?.models && Array.isArray(data.models)) {
                    setModels(data.models)
                }
            })
            .catch(() => {})
    }, [isAuthenticated])

    // Fetch conversations when authenticated
    const loadConversations = useCallback(async () => {
        if (!isAuthenticated) return
        try {
            const res = await fetch("/api/conversations", { headers: getAuthHeaders() })
            if (res.ok) {
                const data: any = await res.json()
                setConversations(Array.isArray(data) ? data : [])
            } else {
                const err: any = await res.json().catch(() => ({}))
                if (err.isBindingError) {
                    addToast(
                        "Cloudflare D1 is unconfigured. Replace REPLACE_WITH_D1_ID in cloudflare.config.ts.",
                        true
                    )
                }
            }
        } catch (err: any) {
            console.warn("Could not load conversations:", err?.message)
        }
    }, [isAuthenticated, addToast])

    useEffect(() => {
        if (isAuthenticated) {
            loadConversations()
        }
    }, [isAuthenticated, loadConversations])

    // Update the URL search params (?id=<convId>) without page reload
    const updateUrlConversationId = useCallback(
        (id: string | undefined, replace: boolean = false) => {
            if (typeof window === "undefined") return
            const url = new URL(window.location.href)
            const currentId =
                url.searchParams.get("id") ||
                url.searchParams.get("c") ||
                url.searchParams.get("chat")
            if (currentId === (id || null)) return

            if (id) {
                url.searchParams.set("id", id)
                url.searchParams.delete("c")
                url.searchParams.delete("chat")
            } else {
                url.searchParams.delete("id")
                url.searchParams.delete("c")
                url.searchParams.delete("chat")
            }
            const nextUrl = url.pathname + (url.search ? url.search : "")
            if (replace) {
                window.history.replaceState({ conversationId: id }, "", nextUrl)
            } else {
                window.history.pushState({ conversationId: id }, "", nextUrl)
            }
        },
        []
    )

    // Copy shareable link for a conversation
    const handleCopyConversationLink = useCallback(
        async (id?: string) => {
            const targetId = id || activeConversationId
            if (!targetId || typeof window === "undefined") return
            const url = new URL(window.location.origin + window.location.pathname)
            url.searchParams.set("id", targetId)
            try {
                await navigator.clipboard.writeText(url.toString())
                setCopiedLink(true)
                setTimeout(() => setCopiedLink(false), 2000)
                addToast("Chat link copied to clipboard!")
            } catch {
                addToast("Failed to copy link", true)
            }
        },
        [activeConversationId, addToast]
    )

    // Load conversation messages and optionally update URL
    const loadConversationMessages = useCallback(
        async (id: string, updateUrl: boolean = false, replaceUrl: boolean = false) => {
            try {
                setIsLoadingConversation(true)
                const res = await fetch(`/api/conversations/${id}`, { headers: getAuthHeaders() })
                if (res.ok) {
                    const data: any = await res.json()
                    setMessages(Array.isArray(data.messages) ? data.messages : [])
                    setActiveConversationId(id)
                    if (data.title) {
                        setActiveConversationTitle(data.title)
                    }
                    if (data.model) {
                        setSelectedModel(data.model)
                    }
                    if (updateUrl) {
                        updateUrlConversationId(id, replaceUrl)
                    }
                } else if (res.status === 404) {
                    addToast("Conversation not found", true)
                    setActiveConversationId(undefined)
                    setActiveConversationTitle("")
                    setMessages([])
                    updateUrlConversationId(undefined, true)
                } else {
                    const err: any = await res.json().catch(() => ({}))
                    addToast(err?.error || "Failed to load conversation", true)
                }
            } catch (err: any) {
                addToast(err?.message || "Failed to load conversation messages", true)
            } finally {
                setIsLoadingConversation(false)
            }
        },
        [addToast, updateUrlConversationId]
    )

    // Check URL params on initial mount or authentication to load older conversation
    useEffect(() => {
        if (!isAuthenticated) return
        const params = new URLSearchParams(window.location.search)
        const targetId = params.get("id") || params.get("c") || params.get("chat")
        if (targetId) {
            loadConversationMessages(targetId, true, true)
        }
    }, [isAuthenticated, loadConversationMessages])

    // Handle browser Back and Forward navigation (popstate)
    useEffect(() => {
        if (!isAuthenticated) return

        const handlePopState = () => {
            const params = new URLSearchParams(window.location.search)
            const targetId = params.get("id") || params.get("c") || params.get("chat")
            if (targetId) {
                if (targetId !== activeConversationIdRef.current) {
                    loadConversationMessages(targetId, false, false)
                }
            } else {
                if (activeConversationIdRef.current) {
                    setActiveConversationId(undefined)
                    setActiveConversationTitle("")
                    setMessages([])
                }
            }
        }

        window.addEventListener("popstate", handlePopState)
        return () => window.removeEventListener("popstate", handlePopState)
    }, [isAuthenticated, loadConversationMessages])

    const handleSelectConversation = (id: string) => {
        if (isStreaming) {
            handleStopGeneration()
        }
        const found = conversations.find((c) => c.id === id)
        if (found) {
            setActiveConversationTitle(found.title)
        }
        loadConversationMessages(id, true, false)
    }

    const handleNewChat = () => {
        if (isStreaming) {
            handleStopGeneration()
        }
        setActiveConversationId(undefined)
        setActiveConversationTitle("")
        setMessages([])
        setStreamingContent("")
        setStreamingReasoning("")
        updateUrlConversationId(undefined, false)
    }

    const handleRenameConversation = async (id: string, newTitle: string) => {
        try {
            const res = await fetch(`/api/conversations/${id}`, {
                method: "PATCH",
                headers: getAuthHeaders({ "Content-Type": "application/json" }),
                body: JSON.stringify({ title: newTitle }),
            })
            if (res.ok) {
                setConversations((prev) =>
                    prev.map((c) => (c.id === id ? { ...c, title: newTitle } : c))
                )
                if (activeConversationId === id) {
                    setActiveConversationTitle(newTitle)
                }
            }
        } catch {
            addToast("Failed to rename conversation", true)
        }
    }

    const handleDeleteConversation = async (id: string) => {
        try {
            const res = await fetch(`/api/conversations/${id}`, {
                method: "DELETE",
                headers: getAuthHeaders(),
            })
            if (res.ok) {
                setConversations((prev) => prev.filter((c) => c.id !== id))
                if (activeConversationId === id) {
                    handleNewChat()
                }
            }
        } catch {
            addToast("Failed to delete conversation", true)
        }
    }

    // Scroll detection
    const handleScroll = () => {
        if (!chatScrollContainerRef.current) return
        const { scrollTop, scrollHeight, clientHeight } = chatScrollContainerRef.current
        const distanceFromBottom = scrollHeight - scrollTop - clientHeight
        setUserScrolledUp(distanceFromBottom > 120)
    }

    const scrollToBottom = (behavior: ScrollBehavior = "smooth") => {
        if (chatScrollContainerRef.current) {
            chatScrollContainerRef.current.scrollTo({
                top: chatScrollContainerRef.current.scrollHeight,
                behavior,
            })
        }
    }

    // Auto-scroll when streaming
    useEffect(() => {
        if (!userScrolledUp) {
            scrollToBottom("auto")
        }
    }, [streamingContent, streamingReasoning, messages, userScrolledUp])

    const handleStopGeneration = () => {
        if (abortControllerRef.current) {
            abortControllerRef.current.abort()
            abortControllerRef.current = null
        }
        setIsStreaming(false)
    }

    // Send message
    const handleSendMessage = async (text: string, attachments: Attachment[] = []) => {
        if (isStreaming) return

        const userMessage: Message = {
            id: crypto.randomUUID(),
            conversation_id: activeConversationId || "temp",
            role: "user",
            content: text,
            model: selectedModel,
            effort,
            attachments,
            created_at: Date.now(),
        }

        setMessages((prev) => [...prev, userMessage])
        setIsStreaming(true)
        setStreamingContent("")
        setStreamingReasoning("")
        setUserScrolledUp(false)

        const controller = new AbortController()
        abortControllerRef.current = controller

        try {
            const res = await fetch("/api/chat", {
                method: "POST",
                headers: getAuthHeaders({ "Content-Type": "application/json" }),
                body: JSON.stringify({
                    conversationId: activeConversationId,
                    message: text,
                    model: selectedModel,
                    effort,
                    contextMode,
                    attachments,
                }),
                signal: controller.signal,
            })

            if (!res.ok) {
                const errData: any = await res.json().catch(() => ({}))
                const rawErrMsg = errData.error || `Request failed with status ${res.status}`
                if (
                    rawErrMsg.includes("5016") ||
                    rawErrMsg.includes("submit the prompt 'agree'") ||
                    rawErrMsg.includes("Community License")
                ) {
                    addToast("Accepting model license agreement and retrying...", false)
                    try {
                        await fetch("/api/models/agree", {
                            method: "POST",
                            headers: getAuthHeaders({ "Content-Type": "application/json" }),
                            body: JSON.stringify({ model: selectedModel }),
                        })
                        setIsStreaming(false)
                        setTimeout(() => {
                            handleSendMessage(text, attachments)
                        }, 500)
                        return
                    } catch {}
                }

                if (res.status === 503 || errData.isBindingError) {
                    addToast(errData.error || "Cloudflare resource binding is unconfigured.", true)
                } else {
                    addToast(rawErrMsg, true)
                }
                setIsStreaming(false)
                return
            }

            if (!res.body) {
                throw new Error("No response body received from server")
            }

            const reader = res.body.getReader()
            const decoder = new TextDecoder()
            let buffer = ""
            let accumulatedContent = ""
            let accumulatedReasoning = ""
            let serverConversationId = activeConversationId
            let finalMessageId = ""

            while (true) {
                const { done, value } = await reader.read()
                if (done) break

                buffer += decoder.decode(value, { stream: true })
                const lines = buffer.split("\n")
                buffer = lines.pop() || ""

                for (const line of lines) {
                    const trimmed = line.trim()
                    if (!trimmed || !trimmed.startsWith("data:")) continue

                    const rawData = trimmed.replace(/^data:\s*/, "")
                    if (rawData === "[DONE]") {
                        break
                    }

                    try {
                        const event = JSON.parse(rawData)
                        if (event.error) {
                            const errStr = String(event.error)
                            if (
                                errStr.includes("5016") ||
                                errStr.includes("submit the prompt 'agree'") ||
                                errStr.includes("Community License")
                            ) {
                                addToast("Accepting model license agreement and retrying...", false)
                                try {
                                    await fetch("/api/models/agree", {
                                        method: "POST",
                                        headers: getAuthHeaders({
                                            "Content-Type": "application/json",
                                        }),
                                        body: JSON.stringify({ model: selectedModel }),
                                    })
                                    setIsStreaming(false)
                                    setTimeout(() => {
                                        handleSendMessage(text, attachments)
                                    }, 500)
                                    break
                                } catch {}
                            }
                            addToast(event.error, true)
                            break
                        }
                        if (event.conversationId) {
                            serverConversationId = event.conversationId
                            setActiveConversationId((prev) => {
                                if (!prev) {
                                    updateUrlConversationId(event.conversationId, true)
                                    return event.conversationId
                                }
                                return prev
                            })
                        }
                        if (event.messageId) {
                            finalMessageId = event.messageId
                        }
                        if (event.reasoning) {
                            accumulatedReasoning += event.reasoning
                            setStreamingReasoning(accumulatedReasoning)
                        }
                        if (event.delta) {
                            accumulatedContent += event.delta
                            setStreamingContent(accumulatedContent)
                        }
                        if (event.done) {
                            break
                        }
                    } catch {
                        // Non-JSON SSE line
                    }
                }
            }

            // Finish streaming and add assistant message
            const assistantMessage: Message = {
                id: finalMessageId || crypto.randomUUID(),
                conversation_id: serverConversationId || "temp",
                role: "assistant",
                content: accumulatedContent,
                model: selectedModel,
                effort,
                reasoning: accumulatedReasoning || undefined,
                created_at: Date.now(),
            }

            setMessages((prev) => [...prev, assistantMessage])
            setStreamingContent("")
            setStreamingReasoning("")
            setIsStreaming(false)

            if (serverConversationId) {
                if (serverConversationId !== activeConversationId) {
                    setActiveConversationId(serverConversationId)
                }
                updateUrlConversationId(serverConversationId, true)
            }
            loadConversations()
        } catch (err: any) {
            if (err.name !== "AbortError") {
                console.error("Chat error:", err)
                addToast(err?.message || "Generation was interrupted", true)
            }
            setIsStreaming(false)
            setStreamingContent("")
            setStreamingReasoning("")
        } finally {
            abortControllerRef.current = null
            fetchUsageMetrics()
        }
    }

    const handleRegenerate = () => {
        if (isStreaming || messages.length === 0) return
        const lastUserIndex = messages.map((m) => m.role).lastIndexOf("user")
        if (lastUserIndex === -1) return

        const userMessage = messages[lastUserIndex]
        // Remove messages after the user message
        setMessages((prev) => prev.slice(0, lastUserIndex))
        handleSendMessage(userMessage.content, userMessage.attachments || [])
    }

    // Lock application and return to PIN screen
    const handleLockApp = () => {
        if (typeof window !== "undefined") {
            localStorage.removeItem(AUTH_STORAGE_KEY)
        }
        setIsAuthenticated(false)
        addToast("Application locked.")
    }

    // Greeting based on time of day
    const getGreeting = () => {
        const hour = new Date().getHours()
        if (hour < 12) return "Good morning"
        if (hour < 18) return "Good afternoon"
        return "Good evening"
    }

    // While checking localStorage, show clean background
    if (isAuthenticated === null) {
        return (
            <div className="flex h-dvh w-screen items-center justify-center bg-[var(--background)]">
                <div className="w-8 h-8 rounded-xl bg-[var(--accent)] animate-pulse" />
            </div>
        )
    }

    // If not authenticated, render 4-digit verification code screen
    if (isAuthenticated === false) {
        return <PinLogin onSuccess={() => setIsAuthenticated(true)} />
    }

    return (
        <div className="flex h-dvh w-screen overflow-hidden bg-[var(--background)] text-[var(--text-primary)]">
            {/* Left Sidebar */}
            <Sidebar
                conversations={conversations}
                activeConversationId={activeConversationId}
                onSelectConversation={handleSelectConversation}
                onNewChat={handleNewChat}
                onRenameConversation={handleRenameConversation}
                onDeleteConversation={handleDeleteConversation}
                onCopyLink={handleCopyConversationLink}
                onOpenKnowledgeBase={() => setIsKnowledgeBaseOpen(true)}
                onOpenUsage={() => setIsUsageOpen(true)}
                onLockApp={handleLockApp}
                isOpenMobile={isMobileSidebarOpen}
                onCloseMobile={() => setIsMobileSidebarOpen(false)}
                theme={theme}
                onToggleTheme={toggleTheme}
                usageSummary={usageSummary}
            />

            {/* Main Chat Column */}
            <div className="flex-1 flex flex-col h-full min-w-0 relative">
                {/* Top Navbar */}
                <header className="h-14 border-b border-[var(--border)] px-2.5 sm:px-4 flex items-center justify-between bg-[var(--background)]/85 backdrop-blur-md z-10 shrink-0 gap-2">
                    <div className="flex items-center gap-1.5 sm:gap-2 min-w-0 flex-1">
                        <button
                            type="button"
                            onClick={() => setIsMobileSidebarOpen(true)}
                            className="md:hidden p-2 rounded-xl text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--button-hover)] shrink-0 active:scale-95 cursor-pointer"
                            aria-label="Open sidebar"
                        >
                            <MenuIcon size={18} />
                        </button>
                        <span className="text-xs sm:text-sm font-semibold text-[var(--text-primary)] truncate max-w-[140px] xs:max-w-[200px] sm:max-w-md">
                            {activeConversationId
                                ? activeConversationTitle ||
                                  conversations.find((c) => c.id === activeConversationId)?.title ||
                                  "Chat"
                                : "Cloudflare AI"}
                        </span>

                        {/* Quick Share / Copy Link button when chat is active (Desktop) */}
                        {activeConversationId && (
                            <button
                                type="button"
                                onClick={() => handleCopyConversationLink(activeConversationId)}
                                className="hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-medium text-[var(--accent)] hover:bg-[var(--selected-bg)] transition-colors cursor-pointer border border-[var(--accent)]/30 shrink-0"
                                title="Copy shareable link for this conversation"
                            >
                                {copiedLink ? (
                                    <CheckIcon size={12} className="text-emerald-500" />
                                ) : (
                                    <LinkIcon size={12} />
                                )}
                                <span>{copiedLink ? "Link Copied" : "Copy Link"}</span>
                            </button>
                        )}
                    </div>

                    <div className="flex items-center gap-1 sm:gap-1.5 shrink-0">
                        {/* Mobile quick copy button */}
                        {activeConversationId && (
                            <button
                                type="button"
                                onClick={() => handleCopyConversationLink(activeConversationId)}
                                className="sm:hidden p-2 rounded-xl text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--button-hover)] border border-[var(--border)] bg-[var(--surface-bg)] transition-colors cursor-pointer active:scale-95"
                                title="Copy shareable chat link"
                                aria-label="Copy chat link"
                            >
                                {copiedLink ? (
                                    <CheckIcon size={15} className="text-emerald-500" />
                                ) : (
                                    <LinkIcon size={15} className="text-[var(--accent)]" />
                                )}
                            </button>
                        )}

                        <button
                            type="button"
                            onClick={() => setIsUsageOpen(true)}
                            className="inline-flex items-center gap-1.5 p-2 sm:px-2.5 sm:py-1.5 rounded-xl text-xs font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--button-hover)] border border-[var(--border)] bg-[var(--surface-bg)] transition-colors cursor-pointer active:scale-95"
                            title="Workers AI daily usage & free tier quota"
                            aria-label="Workers AI Usage"
                        >
                            <ActivityIcon size={15} className="text-[var(--accent)]" />
                            <span className="hidden sm:inline">Usage</span>
                            <span className="hidden xs:inline text-[10px] font-mono px-1 py-0.2 rounded bg-emerald-500/10 text-emerald-500">
                                10k Free
                            </span>
                        </button>

                        <button
                            type="button"
                            onClick={() => setIsKnowledgeBaseOpen(true)}
                            className="inline-flex items-center gap-1.5 p-2 sm:px-2.5 sm:py-1.5 rounded-xl text-xs font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--button-hover)] border border-[var(--border)] bg-[var(--surface-bg)] transition-colors cursor-pointer active:scale-95"
                            title="Knowledge Base & RAG documents"
                            aria-label="Knowledge Base"
                        >
                            <BookOpenIcon size={15} className="text-[var(--accent)]" />
                            <span className="hidden sm:inline">Knowledge Base</span>
                        </button>

                        <button
                            type="button"
                            onClick={handleLockApp}
                            className="p-2 rounded-xl text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--button-hover)] border border-[var(--border)] bg-[var(--surface-bg)] transition-colors cursor-pointer active:scale-95"
                            title="Lock application (require PIN)"
                            aria-label="Lock application"
                        >
                            <LockIcon size={15} />
                        </button>
                    </div>
                </header>

                {/* Message Viewport */}
                <div
                    ref={chatScrollContainerRef}
                    onScroll={handleScroll}
                    className="flex-1 overflow-y-auto px-2.5 sm:px-4 py-4 sm:py-6 custom-scrollbar relative"
                >
                    {isLoadingConversation ? (
                        <div className="max-w-2xl mx-auto h-full flex flex-col items-center justify-center text-center px-4 py-12">
                            <div className="w-8 h-8 rounded-full border-2 border-[var(--border)] border-t-[var(--accent)] animate-spin mb-3" />
                            <p className="text-xs text-[var(--text-muted)] font-medium">
                                Loading conversation history...
                            </p>
                        </div>
                    ) : messages.length === 0 && !isStreaming ? (
                        /* Empty State */
                        <div className="max-w-2xl mx-auto h-full flex flex-col items-center justify-center text-center px-3 sm:px-4 py-8 sm:py-12">
                            <div className="w-10 h-10 sm:w-12 sm:h-12 rounded-2xl bg-[var(--accent)] text-white flex items-center justify-center font-serif font-bold text-xl sm:text-2xl shadow-md mb-3 sm:mb-4">
                                C
                            </div>
                            <h1 className="text-xl sm:text-3xl font-serif font-medium text-[var(--text-primary)] tracking-tight mb-2">
                                {getGreeting()}
                            </h1>
                            <p className="text-xs sm:text-sm text-[var(--text-muted)] max-w-md mb-6 sm:mb-8 leading-relaxed">
                                Ask anything, synthesize complex code, analyze images, or query
                                documents with Cloudflare RAG.
                            </p>

                            {/* 3 Suggested Prompt Cards */}
                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 sm:gap-3 w-full">
                                {SUGGESTED_PROMPTS.map((item, idx) => (
                                    <button
                                        key={idx}
                                        type="button"
                                        onClick={() => handleSendMessage(item.prompt)}
                                        className="p-3 sm:p-4 rounded-xl sm:rounded-2xl border border-[var(--border)] bg-[var(--surface-bg)] hover:bg-[var(--selected-bg)] hover:border-[var(--accent)] text-left transition-all shadow-xs group active:scale-[0.99] cursor-pointer"
                                    >
                                        <div className="flex items-center gap-1.5 text-xs font-semibold text-[var(--text-primary)] mb-1 group-hover:text-[var(--accent)]">
                                            <SparklesIcon
                                                size={13}
                                                className="text-[var(--accent)] shrink-0"
                                            />
                                            <span className="truncate">{item.title}</span>
                                        </div>
                                        <p className="text-[11px] sm:text-xs text-[var(--text-muted)] line-clamp-2 sm:line-clamp-3 leading-relaxed">
                                            {item.prompt}
                                        </p>
                                    </button>
                                ))}
                            </div>
                        </div>
                    ) : (
                        /* Active Message List */
                        <div className="max-w-3xl mx-auto">
                            {messages.map((msg) => (
                                <ChatMessage
                                    key={msg.id}
                                    message={msg}
                                    onRegenerate={
                                        msg.role === "assistant" ? handleRegenerate : undefined
                                    }
                                />
                            ))}

                            {/* Live Streaming Message */}
                            {isStreaming && (
                                <ChatMessage
                                    message={{
                                        id: "streaming",
                                        conversation_id: activeConversationId || "temp",
                                        role: "assistant",
                                        content: streamingContent,
                                        reasoning: streamingReasoning,
                                        model: selectedModel,
                                        effort,
                                        created_at: Date.now(),
                                    }}
                                    isStreaming={true}
                                />
                            )}
                        </div>
                    )}

                    {/* Floating Scroll to Bottom Button */}
                    {userScrolledUp && (
                        <button
                            type="button"
                            onClick={() => scrollToBottom("smooth")}
                            className="fixed bottom-24 sm:bottom-28 right-4 sm:right-8 p-2 rounded-full bg-[var(--surface-bg)] text-[var(--text-primary)] border border-[var(--border)] shadow-lg hover:bg-[var(--button-hover)] transition-all z-20 cursor-pointer"
                            title="Scroll to bottom"
                            aria-label="Scroll to bottom"
                        >
                            <ArrowDownIcon size={16} />
                        </button>
                    )}
                </div>

                {/* Bottom Composer */}
                <ChatComposer
                    models={models}
                    selectedModel={selectedModel}
                    onSelectModel={handleSelectModel}
                    contextMode={contextMode}
                    onChangeContextMode={handleChangeContextMode}
                    effort={effort}
                    onChangeEffort={handleChangeEffort}
                    onSendMessage={handleSendMessage}
                    isStreaming={isStreaming}
                    onStopGeneration={handleStopGeneration}
                    onNotification={addToast}
                />
            </div>

            {/* Knowledge Base Modal */}
            <KnowledgeBaseModal
                isOpen={isKnowledgeBaseOpen}
                onClose={() => setIsKnowledgeBaseOpen(false)}
                onNotification={addToast}
            />

            {/* Usage & Limits Modal */}
            <UsageModal isOpen={isUsageOpen} onClose={() => setIsUsageOpen(false)} />

            {/* Toast Notifications */}
            <Toast toasts={toasts} onDismiss={dismissToast} />
        </div>
    )
}
