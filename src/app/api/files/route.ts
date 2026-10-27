import { listDocuments } from "@/lib/db"
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

        const docs = await listDocuments()
        return Response.json(docs)
    } catch (error: any) {
        console.error("Error in GET /api/files:", error)
        const isBindingError = error?.name === "DatabaseBindingError"
        return Response.json(
            { error: error?.message || "Failed to list documents", isBindingError },
            { status: isBindingError ? 503 : 500 }
        )
    }
}
