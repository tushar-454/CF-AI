import { Suspense } from "react"
import { YouTubeChatWorkspace } from "@/components/YouTubeChatWorkspace"

export const metadata = {
    title: "YouTube Video Chat | Cloudflare AI",
    description:
        "Chat with any YouTube video using synchronized transcript playback and DeepSeek R1 reasoning.",
}

export default function YouTubePage() {
    return (
        <main className="h-dvh w-screen overflow-hidden">
            <Suspense fallback={<div className="h-dvh w-screen bg-[var(--background)]" />}>
                <YouTubeChatWorkspace />
            </Suspense>
        </main>
    )
}
