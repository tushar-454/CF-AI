"use client";

import React, { useState, useRef, useEffect } from "react";
import { MicIcon, MicOffIcon } from "./Icons";
import { getAuthHeaders } from "@/lib/auth";

interface VoiceInputProps {
  onTranscript: (text: string) => void;
  onError: (errorMsg: string) => void;
}

export function VoiceInput({ onTranscript, onError }: VoiceInputProps) {
  const [isRecording, setIsRecording] = useState(false);
  const [mode, setMode] = useState<"speechRecognition" | "mediaRecorder" | "unsupported">("speechRecognition");

  const recognitionRef = useRef<any>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);

  useEffect(() => {
    if (typeof window !== "undefined") {
      const SpeechRecognition =
        (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
      if (SpeechRecognition) {
        setMode("speechRecognition");
      } else if (navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === "function") {
        setMode("mediaRecorder");
      } else {
        setMode("unsupported");
      }
    }
  }, []);

  const startRecording = async () => {
    if (mode === "speechRecognition") {
      const SpeechRecognition =
        (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
      if (!SpeechRecognition) return;

      try {
        const recognition = new SpeechRecognition();
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.lang = "en-US";

        recognition.onstart = () => {
          setIsRecording(true);
        };

        recognition.onresult = (event: any) => {
          let finalTranscript = "";
          for (let i = event.resultIndex; i < event.results.length; ++i) {
            if (event.results[i].isFinal) {
              finalTranscript += event.results[i][0].transcript + " ";
            }
          }
          if (finalTranscript) {
            onTranscript(finalTranscript.trim());
          }
        };

        recognition.onerror = (event: any) => {
          console.error("SpeechRecognition error:", event.error);
          setIsRecording(false);
          if (event.error === "not-allowed" || event.error === "service-not-allowed") {
            onError("Microphone permission denied. Please allow microphone access in your browser.");
          } else if (event.error !== "no-speech") {
            onError(`Voice input error: ${event.error}`);
          }
        };

        recognition.onend = () => {
          setIsRecording(false);
        };

        recognition.start();
        recognitionRef.current = recognition;
      } catch (err: any) {
        setIsRecording(false);
        onError(err?.message || "Could not start voice recognition.");
      }
    } else if (mode === "mediaRecorder") {
      // Fallback: MediaRecorder + /api/transcribe
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const mediaRecorder = new MediaRecorder(stream);
        audioChunksRef.current = [];

        mediaRecorder.ondataavailable = (event) => {
          if (event.data.size > 0) {
            audioChunksRef.current.push(event.data);
          }
        };

        mediaRecorder.onstop = async () => {
          const audioBlob = new Blob(audioChunksRef.current, { type: mediaRecorder.mimeType || "audio/webm" });
          stream.getTracks().forEach((track) => track.stop());

          try {
            const formData = new FormData();
            formData.append("audio", audioBlob, "recording.webm");

            const res = await fetch("/api/transcribe", {
              method: "POST",
              headers: getAuthHeaders(),
              body: formData,
            });

            const data: any = await res.json().catch(() => ({}));
            if (!res.ok) {
              throw new Error(data.error || "Failed to transcribe audio");
            }

            if (data.text) {
              onTranscript(data.text);
            }
          } catch (transcribeErr: any) {
            onError(transcribeErr?.message || "Audio transcription failed.");
          }
        };

        mediaRecorder.start();
        mediaRecorderRef.current = mediaRecorder;
        setIsRecording(true);
      } catch (err: any) {
        setIsRecording(false);
        if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") {
          onError("Microphone permission denied. Please enable microphone access in your browser.");
        } else {
          onError("Could not access microphone: " + err.message);
        }
      }
    } else {
      onError("Voice input is not supported in this browser.");
    }
  };

  const stopRecording = () => {
    if (mode === "speechRecognition" && recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch {}
      recognitionRef.current = null;
    } else if (mode === "mediaRecorder" && mediaRecorderRef.current) {
      try {
        mediaRecorderRef.current.stop();
      } catch {}
      mediaRecorderRef.current = null;
    }
    setIsRecording(false);
  };

  const toggleRecording = () => {
    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  };

  return (
    <button
      type="button"
      onClick={toggleRecording}
      className={`p-1.5 rounded-lg text-xs font-medium transition-all ${
        isRecording
          ? "bg-red-500/10 text-red-600 dark:text-red-400 border border-red-300 dark:border-red-800 animate-pulse"
          : "text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--button-hover)]"
      }`}
      title={isRecording ? "Stop voice typing" : "Start voice typing (speech-to-text)"}
      aria-label="Voice input"
    >
      {isRecording ? <MicOffIcon size={16} /> : <MicIcon size={16} />}
    </button>
  );
}
