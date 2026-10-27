"use client"

import React, { useState, useRef, useEffect } from "react"
import { MicIcon, MicOffIcon, RefreshCwIcon } from "./Icons"
import { getAuthHeaders } from "@/lib/auth-client"

interface SpeechRecognitionResultItem {
    transcript: string
    confidence?: number
}

interface SpeechRecognitionResult {
    isFinal: boolean
    length: number
    [index: number]: SpeechRecognitionResultItem
}

interface SpeechRecognitionResultList {
    length: number
    [index: number]: SpeechRecognitionResult
}

interface SpeechRecognitionEvent {
    resultIndex: number
    results: SpeechRecognitionResultList
}

interface SpeechRecognitionErrorEvent {
    error: string
    message?: string
}

interface ISpeechRecognition {
    continuous: boolean
    interimResults: boolean
    lang: string
    onstart: (() => void) | null
    onresult: ((event: SpeechRecognitionEvent) => void) | null
    onerror: ((event: SpeechRecognitionErrorEvent) => void) | null
    onend: (() => void) | null
    start: () => void
    stop: () => void
    abort: () => void
}

type SpeechRecognitionConstructor = new () => ISpeechRecognition

interface WindowWithSpeechRecognition extends Window {
    SpeechRecognition?: SpeechRecognitionConstructor
    webkitSpeechRecognition?: SpeechRecognitionConstructor
}

interface VoiceInputProps {
    onTranscript: (text: string) => void
    onError: (errorMsg: string) => void
}

export function VoiceInput({ onTranscript, onError }: VoiceInputProps) {
    const [isRecording, setIsRecording] = useState(false)
    const [isTranscribing, setIsTranscribing] = useState(false)
    const [mode, setMode] = useState<"speechRecognition" | "mediaRecorder" | "unsupported">(
        "speechRecognition"
    )

    const recognitionRef = useRef<ISpeechRecognition | null>(null)
    const mediaRecorderRef = useRef<MediaRecorder | null>(null)
    const streamRef = useRef<MediaStream | null>(null)
    const audioChunksRef = useRef<Blob[]>([])

    useEffect(() => {
        if (typeof window !== "undefined") {
            const savedMode = localStorage.getItem("cf_ai_voice_mode")
            if (
                savedMode === "mediaRecorder" &&
                typeof navigator.mediaDevices?.getUserMedia === "function"
            ) {
                setMode("mediaRecorder")
                return
            }

            const win = window as unknown as WindowWithSpeechRecognition
            const SpeechRecognition = win.SpeechRecognition || win.webkitSpeechRecognition
            if (SpeechRecognition) {
                setMode("speechRecognition")
            } else if (
                navigator.mediaDevices &&
                typeof navigator.mediaDevices.getUserMedia === "function"
            ) {
                setMode("mediaRecorder")
            } else {
                setMode("unsupported")
            }
        }
    }, [])

    const stopTracks = () => {
        if (streamRef.current) {
            streamRef.current.getTracks().forEach((track) => track.stop())
            streamRef.current = null
        }
    }

    const startMediaRecorder = async () => {
        try {
            if (typeof navigator.mediaDevices?.getUserMedia !== "function") {
                throw new Error("Microphone access is not supported in this browser.")
            }

            const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
            streamRef.current = stream

            let mimeType = "audio/webm"
            if (
                typeof MediaRecorder !== "undefined" &&
                typeof MediaRecorder.isTypeSupported === "function"
            ) {
                if (MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) {
                    mimeType = "audio/webm;codecs=opus"
                } else if (MediaRecorder.isTypeSupported("audio/webm")) {
                    mimeType = "audio/webm"
                } else if (MediaRecorder.isTypeSupported("audio/mp4")) {
                    mimeType = "audio/mp4"
                } else if (MediaRecorder.isTypeSupported("audio/ogg")) {
                    mimeType = "audio/ogg"
                }
            }

            const mediaRecorder = new MediaRecorder(stream, { mimeType })
            audioChunksRef.current = []

            mediaRecorder.ondataavailable = (event) => {
                if (event.data.size > 0) {
                    audioChunksRef.current.push(event.data)
                }
            }

            mediaRecorder.onstop = async () => {
                setIsRecording(false)
                stopTracks()

                const audioBlob = new Blob(audioChunksRef.current, { type: mimeType })
                if (audioBlob.size < 800) {
                    return
                }

                setIsTranscribing(true)
                try {
                    const formData = new FormData()
                    formData.append("audio", audioBlob, "recording.webm")

                    const res = await fetch("/api/transcribe", {
                        method: "POST",
                        headers: getAuthHeaders(),
                        body: formData,
                    })

                    const data = (await res.json().catch(() => ({}))) as {
                        error?: string
                        text?: string
                    }
                    if (!res.ok) {
                        throw new Error(data.error || "Failed to transcribe audio")
                    }

                    if (data.text && data.text.trim()) {
                        onTranscript(data.text.trim())
                    } else {
                        onError("No clear speech detected. Please speak closer to the microphone.")
                    }
                } catch (transcribeErr: unknown) {
                    const msg =
                        transcribeErr instanceof Error
                            ? transcribeErr.message
                            : "Audio transcription failed."
                    onError(msg)
                } finally {
                    setIsTranscribing(false)
                }
            }

            mediaRecorder.start(250)
            mediaRecorderRef.current = mediaRecorder
            setIsRecording(true)
        } catch (err: unknown) {
            setIsRecording(false)
            stopTracks()
            const errName = err instanceof Error ? err.name : ""
            const errMsg = err instanceof Error ? err.message : "Unknown error"
            if (errName === "NotAllowedError" || errName === "PermissionDeniedError") {
                onError(
                    "Microphone permission denied. Please allow microphone access in your browser settings."
                )
            } else {
                onError("Could not access microphone: " + errMsg)
            }
        }
    }

    const startSpeechRecognition = () => {
        const win = window as unknown as WindowWithSpeechRecognition
        const SpeechRecognition = win.SpeechRecognition || win.webkitSpeechRecognition
        if (!SpeechRecognition) {
            setMode("mediaRecorder")
            startMediaRecorder()
            return
        }

        try {
            const recognition = new SpeechRecognition()
            recognition.continuous = true
            recognition.interimResults = true
            recognition.lang = "en-US"

            recognition.onstart = () => {
                setIsRecording(true)
            }

            recognition.onresult = (event: SpeechRecognitionEvent) => {
                let finalTranscript = ""
                for (let i = event.resultIndex; i < event.results.length; ++i) {
                    if (event.results[i].isFinal) {
                        finalTranscript += event.results[i][0].transcript + " "
                    }
                }
                if (finalTranscript) {
                    onTranscript(finalTranscript.trim())
                }
            }

            recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
                console.warn("SpeechRecognition error:", event.error)
                setIsRecording(false)

                // Network error happens in Chromium on Linux, Brave, or restricted networks:
                // Automatically switch to server-side Whisper via MediaRecorder!
                if (event.error === "network" || event.error === "service-not-allowed") {
                    setMode("mediaRecorder")
                    localStorage.setItem("cf_ai_voice_mode", "mediaRecorder")
                    startMediaRecorder()
                    return
                }

                if (event.error === "not-allowed") {
                    onError(
                        "Microphone permission denied. Please allow microphone access in your browser."
                    )
                } else if (event.error !== "no-speech") {
                    onError(`Voice input error: ${event.error}`)
                }
            }

            recognition.onend = () => {
                setIsRecording(false)
            }

            recognition.start()
            recognitionRef.current = recognition
        } catch (err: unknown) {
            console.warn("Could not start SpeechRecognition, falling back to MediaRecorder:", err)
            setMode("mediaRecorder")
            localStorage.setItem("cf_ai_voice_mode", "mediaRecorder")
            startMediaRecorder()
        }
    }

    const startRecording = () => {
        if (mode === "speechRecognition") {
            startSpeechRecognition()
        } else if (mode === "mediaRecorder") {
            startMediaRecorder()
        }
    }

    const stopRecording = () => {
        if (mode === "speechRecognition" && recognitionRef.current) {
            try {
                recognitionRef.current.stop()
            } catch {
                // Ignore if already stopped
            }
            recognitionRef.current = null
            setIsRecording(false)
        } else if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
            mediaRecorderRef.current.stop()
        }
    }

    const toggleRecording = () => {
        if (isRecording) {
            stopRecording()
        } else {
            startRecording()
        }
    }

    if (mode === "unsupported") {
        return null
    }

    return (
        <button
            type="button"
            onClick={toggleRecording}
            disabled={isTranscribing}
            className={`p-2 rounded-xl transition-all cursor-pointer ${
                isRecording
                    ? "bg-red-500 text-white animate-pulse"
                    : isTranscribing
                      ? "bg-[var(--selected-bg)] text-[var(--accent)]"
                      : "text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--button-hover)]"
            }`}
            title={
                isTranscribing
                    ? "Transcribing audio using Whisper..."
                    : isRecording
                      ? "Stop recording"
                      : mode === "speechRecognition"
                        ? "Voice input (SpeechRecognition / Whisper)"
                        : "Voice input (Workers AI Whisper)"
            }
            aria-label={
                isRecording
                    ? "Stop recording"
                    : isTranscribing
                      ? "Transcribing audio"
                      : "Start voice input"
            }
        >
            {isTranscribing ? (
                <RefreshCwIcon size={16} className="animate-spin text-[var(--accent)]" />
            ) : isRecording ? (
                <MicOffIcon size={16} />
            ) : (
                <MicIcon size={16} />
            )}
        </button>
    )
}
