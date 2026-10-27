"use client"

import { AUTH_HEADER_NAME, AUTH_STORAGE_KEY } from "@/lib/auth-client"
import { ClipboardEvent, KeyboardEvent, useEffect, useRef, useState } from "react"
import { LockIcon, ShieldCheckIcon } from "./Icons"

interface PinLoginProps {
    onSuccess: () => void
}

export function PinLogin({ onSuccess }: PinLoginProps) {
    const [digits, setDigits] = useState<string[]>(["", "", "", ""])
    const [error, setError] = useState<string | null>(null)
    const [isShaking, setIsShaking] = useState(false)
    const [isVerifying, setIsVerifying] = useState(false)
    const [showPin, setShowPin] = useState(false)
    const inputRefs = useRef<(HTMLInputElement | null)[]>([])

    // Focus first input on mount
    useEffect(() => {
        inputRefs.current[0]?.focus()
    }, [])

    const triggerShake = () => {
        setIsShaking(true)
        setTimeout(() => setIsShaking(false), 500)
    }

    const handleVerify = async (pinToTest: string) => {
        if (isVerifying) return
        setIsVerifying(true)
        setError(null)

        try {
            const res = await fetch("/api/auth/verify", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    [AUTH_HEADER_NAME]: pinToTest,
                },
                body: JSON.stringify({ pin: pinToTest }),
            })

            if (res.ok) {
                setError(null)
                localStorage.setItem(AUTH_STORAGE_KEY, pinToTest)
                onSuccess()
            } else {
                setError("Incorrect PIN. Please check and try again.")
                triggerShake()
                setDigits(["", "", "", ""])
                inputRefs.current[0]?.focus()
            }
        } catch {
            setError("Network error verifying PIN. Please try again.")
            triggerShake()
        } finally {
            setIsVerifying(false)
        }
    }

    const handleChange = (index: number, value: string) => {
        // Only accept numeric digit
        const cleaned = value.replace(/\D/g, "")
        if (!cleaned) {
            const next = [...digits]
            next[index] = ""
            setDigits(next)
            return
        }

        const digit = cleaned.slice(-1)
        const next = [...digits]
        next[index] = digit
        setDigits(next)
        setError(null)

        // Auto-advance to next input
        if (index < 3) {
            inputRefs.current[index + 1]?.focus()
        } else {
            // All 4 digits entered, verify automatically
            const fullPin = next.join("")
            if (fullPin.length === 4) {
                handleVerify(fullPin)
            }
        }
    }

    const handleKeyDown = (index: number, e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key === "Backspace") {
            if (digits[index] === "" && index > 0) {
                // Move to previous and clear it
                const next = [...digits]
                next[index - 1] = ""
                setDigits(next)
                inputRefs.current[index - 1]?.focus()
            }
        } else if (e.key === "ArrowLeft" && index > 0) {
            inputRefs.current[index - 1]?.focus()
        } else if (e.key === "ArrowRight" && index < 3) {
            inputRefs.current[index + 1]?.focus()
        } else if (e.key === "Enter") {
            const fullPin = digits.join("")
            if (fullPin.length === 4) {
                handleVerify(fullPin)
            }
        }
    }

    const handlePaste = (e: ClipboardEvent<HTMLInputElement>) => {
        e.preventDefault()
        const pasted = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, 4)
        if (!pasted) return

        const next = ["", "", "", ""]
        for (let i = 0; i < pasted.length; i++) {
            next[i] = pasted[i]
        }
        setDigits(next)
        setError(null)

        if (pasted.length === 4) {
            handleVerify(pasted)
        } else {
            inputRefs.current[pasted.length]?.focus()
        }
    }

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[var(--background)] text-[var(--text-primary)]">
            {/* Background soft ambient glow */}
            <div className="absolute inset-0 overflow-hidden pointer-events-none">
                <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[500px] h-[500px] bg-[var(--accent)]/5 rounded-full blur-3xl" />
            </div>

            <div
                className={`relative w-full max-w-md bg-[var(--surface-bg)] border border-[var(--border)] rounded-3xl p-8 shadow-2xl flex flex-col items-center text-center transition-transform ${
                    isShaking ? "animate-shake" : ""
                }`}
            >
                {/* Top Logo / Icon */}
                <div className="w-14 h-14 rounded-2xl bg-[var(--accent)] text-white flex items-center justify-center shadow-lg shadow-[var(--accent)]/20 mb-6">
                    <LockIcon size={26} />
                </div>

                <h1 className="text-xl sm:text-2xl font-serif font-semibold tracking-tight mb-2">
                    Enter Security PIN
                </h1>
                <p className="text-xs text-[var(--text-muted)] max-w-xs mb-8">
                    This Cloudflare AI instance is protected. Enter the 4-digit verification PIN to
                    continue.
                </p>

                {/* 4 Digit Verification Code Inputs */}
                <div className="flex items-center justify-center gap-3 sm:gap-4 mb-6">
                    {digits.map((digit, idx) => (
                        <input
                            key={idx}
                            ref={(el) => {
                                inputRefs.current[idx] = el
                            }}
                            type={showPin ? "text" : "password"}
                            inputMode="numeric"
                            pattern="[0-9]*"
                            maxLength={1}
                            value={digit}
                            onChange={(e) => handleChange(idx, e.target.value)}
                            onKeyDown={(e) => handleKeyDown(idx, e)}
                            onPaste={idx === 0 ? handlePaste : undefined}
                            className={`w-12 h-14 sm:w-14 sm:h-16 text-center text-2xl font-mono font-bold rounded-2xl bg-[var(--main-bg)] border-2 transition-all outline-hidden ${
                                error
                                    ? "border-red-500/80 text-red-500 focus:border-red-500"
                                    : digit
                                      ? "border-[var(--accent)] text-[var(--text-primary)]"
                                      : "border-[var(--border)] focus:border-[var(--accent)] text-[var(--text-primary)]"
                            }`}
                            autoComplete="off"
                        />
                    ))}
                </div>

                {/* Error message */}
                {error && (
                    <div className="mb-4 text-xs font-medium text-red-400 bg-red-500/10 border border-red-500/20 px-3 py-1.5 rounded-lg animate-in fade-in">
                        {error}
                    </div>
                )}

                {/* Show PIN toggle & default hint */}
                <div className="flex items-center justify-between w-full text-[11px] text-[var(--text-muted)] px-2 mb-6">
                    <button
                        type="button"
                        onClick={() => setShowPin(!showPin)}
                        className="hover:text-[var(--text-primary)] transition-colors cursor-pointer"
                    >
                        {showPin ? "Hide PIN" : "Show PIN"}
                    </button>
                </div>

                {/* Unlock Button */}
                <button
                    type="button"
                    onClick={() => handleVerify(digits.join(""))}
                    disabled={digits.join("").length !== 4 || isVerifying}
                    className="w-full py-3 px-4 rounded-xl font-medium text-xs bg-[var(--accent)] hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed text-white transition-all shadow-md flex items-center justify-center gap-2 cursor-pointer"
                >
                    <ShieldCheckIcon size={16} />
                    <span>{isVerifying ? "Verifying..." : "Unlock & Access Chat"}</span>
                </button>
            </div>
        </div>
    )
}
