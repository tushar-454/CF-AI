import { listConversations } from "@/lib/db"
import { verifyPin } from "@/lib/auth"

export async function GET(req: Request) {
    try {
        const pin = req.headers.get("x-app-pin")
        if (!verifyPin(pin, req)) {
            return Response.json(
                { error: "Unauthorized. Please enter the correct 4-digit security PIN." },
                { status: 401 }
            )
        }

        const conversations = await listConversations()
        return Response.json(conversations)
    } catch (error: unknown) {
        console.error("Error in GET /api/conversations:", error)
        const isBindingError =
            error instanceof Error &&
            (error.name === "DatabaseBindingError" || error.message.includes("REPLACE_WITH_D1_ID"))
        const msg = error instanceof Error ? error.message : "Failed to list conversations"

        return Response.json(
            {
                error: msg,
                isBindingError: Boolean(isBindingError),
            },
            { status: isBindingError ? 503 : 500 }
        )
    }
}
