import { transcribeAudio } from "@/lib/ai"
import { verifyPin } from "@/lib/auth"

export async function POST(req: Request) {
    try {
        const pin = req.headers.get("x-app-pin")
        if (!verifyPin(pin, req)) {
            return Response.json(
                { error: "Unauthorized. Please enter the correct 4-digit security PIN." },
                { status: 401 }
            )
        }

        const contentType = req.headers.get("content-type") || ""
        let audioBytes: ArrayBuffer

        if (contentType.includes("multipart/form-data")) {
            const formData = await req.formData()
            const file = formData.get("audio")
            if (!file || !(file instanceof File)) {
                return Response.json(
                    { error: "No audio file provided in form field 'audio'" },
                    { status: 400 }
                )
            }
            audioBytes = await file.arrayBuffer()
        } else {
            audioBytes = await req.arrayBuffer()
        }

        if (!audioBytes || audioBytes.byteLength === 0) {
            return Response.json({ error: "Empty audio payload" }, { status: 400 })
        }

        const text = await transcribeAudio(audioBytes)
        return Response.json({ text })
    } catch (error: unknown) {
        console.error("Error in POST /api/transcribe:", error)
        const isBindingError = error instanceof Error && error.name === "AiBindingError"
        const msg = error instanceof Error ? error.message : "Transcription failed"
        return Response.json({ error: msg, isBindingError }, { status: isBindingError ? 503 : 500 })
    }
}
