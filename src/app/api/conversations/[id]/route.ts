import { deleteConversation, getConversation, getMessages, updateConversationTitle } from "@/lib/db"
import { z } from "zod"
import { verifyPin } from "@/lib/auth"

const PatchSchema = z.object({
    title: z
        .string()
        .min(1, "Title cannot be empty")
        .max(100, "Title cannot exceed 100 characters"),
})

export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
    try {
        const pin = req.headers.get("x-app-pin")
        if (!verifyPin(pin, req)) {
            return Response.json(
                { error: "Unauthorized. Please enter the correct 4-digit security PIN." },
                { status: 401 }
            )
        }

        const { id } = await context.params
        const conversation = await getConversation(id)
        if (!conversation) {
            return Response.json({ error: "Conversation not found" }, { status: 404 })
        }

        const messages = await getMessages(id, 100)
        return Response.json({
            ...conversation,
            messages,
        })
    } catch (error: unknown) {
        console.error("Error in GET /api/conversations/[id]:", error)
        const isBindingError = error instanceof Error && error.name === "DatabaseBindingError"
        const msg = error instanceof Error ? error.message : "Failed to load conversation"
        return Response.json({ error: msg, isBindingError }, { status: isBindingError ? 503 : 500 })
    }
}

export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
    try {
        const pin = req.headers.get("x-app-pin")
        if (!verifyPin(pin, req)) {
            return Response.json(
                { error: "Unauthorized. Please enter the correct 4-digit security PIN." },
                { status: 401 }
            )
        }

        const { id } = await context.params
        const body = await req.json()
        const parsed = PatchSchema.safeParse(body)

        if (!parsed.success) {
            return Response.json(
                { error: "Invalid title", details: parsed.error.format() },
                { status: 400 }
            )
        }

        await updateConversationTitle(id, parsed.data.title)
        return Response.json({ success: true, title: parsed.data.title })
    } catch (error: unknown) {
        console.error("Error in PATCH /api/conversations/[id]:", error)
        const isBindingError = error instanceof Error && error.name === "DatabaseBindingError"
        const msg = error instanceof Error ? error.message : "Failed to update conversation"
        return Response.json({ error: msg, isBindingError }, { status: isBindingError ? 503 : 500 })
    }
}

export async function DELETE(req: Request, context: { params: Promise<{ id: string }> }) {
    try {
        const pin = req.headers.get("x-app-pin")
        if (!verifyPin(pin, req)) {
            return Response.json(
                { error: "Unauthorized. Please enter the correct 4-digit security PIN." },
                { status: 401 }
            )
        }

        const { id } = await context.params
        await deleteConversation(id)
        return Response.json({ success: true, deletedId: id })
    } catch (error: unknown) {
        console.error("Error in DELETE /api/conversations/[id]:", error)
        const isBindingError = error instanceof Error && error.name === "DatabaseBindingError"
        const msg = error instanceof Error ? error.message : "Failed to delete conversation"
        return Response.json({ error: msg, isBindingError }, { status: isBindingError ? 503 : 500 })
    }
}
