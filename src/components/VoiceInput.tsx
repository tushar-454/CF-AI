"use client"

import React, { useState, useRef, useEffect } from "react"
import { MicIcon, MicOffIcon, RefreshCwIcon } from "./Icons"
import { getAuthHeaders } from "@/lib/auth-client"

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

    const recognitionRef = useRef<any>(null)
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

            const SpeechRecognition =
                (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
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

                    const data: any = await res.json().catch(() => ({}))
                    if (!res.ok) {
                        throw new Error(data.error || "Failed to transcribe audio")
                    }

                    if (data.text && data.text.trim()) {
                        onTranscript(data.text.trim())
                    } else {
                        onError("No clear speech detected. Please speak closer to the microphone.")
                    }
                } catch (transcribeErr: any) {
                    onError(transcribeErr?.message || "Audio transcription failed.")
                } finally {
                    setIsTranscribing(false)
                }
            }

            mediaRecorder.start(250)
            mediaRecorderRef.current = mediaRecorder
            setIsRecording(true)
        } catch (err: any) {
            setIsRecording(false)
            stopTracks()
            if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") {
                onError(
                    "Microphone permission denied. Please allow microphone access in your browser settings."
                )
            } else {
                onError("Could not access microphone: " + (err.message || "Unknown error"))
            }
        }
    }

    const startSpeechRecognition = () => {
        const SpeechRecognition =
            (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
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

            recognition.onresult = (event: any) => {
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

            recognition.onerror = (event: any) => {
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
        } catch (err: any) {
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
        } else {
            onError("Voice input is not supported in this browser.")
        }
    }

    const stopRecording = () => {
        if (mode === "speechRecognition" && recognitionRef.current) {
            try {
                recognitionRef.current.stop()
            } catch {}
            recognitionRef.current = null
            setIsRecording(false)
        } else if (mode === "mediaRecorder" && mediaRecorderRef.current) {
            try {
                if (mediaRecorderRef.current.state !== "inactive") {
                    mediaRecorderRef.current.stop()
                }
            } catch {}
            mediaRecorderRef.current = null
        } else {
            setIsRecording(false)
        }
    }

    const toggleRecording = () => {
        if (isTranscribing) return
        if (isRecording) {
            stopRecording()
        } else {
            startRecording()
        }
    }

    return (
        <button
            type="button"
            onClick={toggleRecording}
            disabled={isTranscribing}
            className={`p-1.5 rounded-lg text-xs font-medium transition-all ${
                isTranscribing
                    ? "bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-300 dark:border-amber-800"
                    : isRecording
                      ? "bg-red-500/10 text-red-600 dark:text-red-400 border border-red-300 dark:border-red-800 animate-pulse"
                      : "text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--button-hover)]"
            }`}
            title={
                isTranscribing
                    ? "Transcribing audio with Whisper..."
                    : isRecording
                      ? "Listening... Click to stop and transcribe"
                      : "Start voice typing (speech-to-text)"
            }
            aria-label="Voice input"
        >
            {isTranscribing ? (
                <RefreshCwIcon size={16} className="animate-spin text-amber-500" />
            ) : isRecording ? (
                <MicOffIcon size={16} />
            ) : (
                <MicIcon size={16} />
            )}
        </button>
    )
}
