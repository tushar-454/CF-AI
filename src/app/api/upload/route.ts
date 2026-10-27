import { createDocument } from "@/lib/db"
import { getR2 } from "@/lib/ai"
import { indexDocument } from "@/lib/rag"
import { env } from "cloudflare:workers"
import { verifyPin } from "@/lib/auth"
import { AppEnv } from "@/lib/types"

const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10 MB

const TEXT_MIME_PATTERNS = [
    /^text\//,
    /application\/json/,
    /application\/javascript/,
    /application\/typescript/,
    /application\/xml/,
    /application\/x-sh/,
    /application\/x-yaml/,
    /application\/sql/,
    /application\/csv/,
]

function isTextFile(mime: string, filename: string): boolean {
    if (TEXT_MIME_PATTERNS.some((pat) => pat.test(mime))) return true
    const ext = filename.split(".").pop()?.toLowerCase()
    const textExtensions = [
        "txt",
        "md",
        "markdown",
        "json",
        "js",
        "jsx",
        "ts",
        "tsx",
        "css",
        "html",
        "htm",
        "csv",
        "yaml",
        "yml",
        "py",
        "rs",
        "go",
        "java",
        "c",
        "cpp",
        "h",
        "sh",
        "sql",
        "env",
        "xml",
    ]
    return ext ? textExtensions.includes(ext) : false
}

export async function POST(req: Request) {
    try {
        const pin = req.headers.get("x-app-pin")
        if (!verifyPin(pin, req)) {
            return Response.json(
                { error: "Unauthorized. Please enter the correct 4-digit security PIN." },
                { status: 401 }
            )
        }

        const formData = await req.formData()
        const file = formData.get("file")
        const rawConversationId =
            (formData.get("conversationId") as string) ||
            (formData.get("conversation_id") as string) ||
            null
        const conversationId =
            rawConversationId && rawConversationId.trim() ? rawConversationId.trim() : null

        if (!file || !(file instanceof File)) {
            return Response.json(
                { error: "No file provided in form-data field 'file'" },
                { status: 400 }
            )
        }

        if (file.size > MAX_FILE_SIZE) {
            return Response.json(
                {
                    error: `File size exceeds the 10 MB limit (${(file.size / (1024 * 1024)).toFixed(1)} MB)`,
                },
                { status: 413 }
            )
        }

        const documentId = crypto.randomUUID()
        const ext = file.name.split(".").pop() || "bin"
        const r2Key = `uploads/${documentId}.${ext}`
        const isImage = file.type.startsWith("image/")
        const isText = isTextFile(file.type, file.name)

        const arrayBuffer = await file.arrayBuffer()

        // Store in R2 bucket
        const r2 = getR2()
        await r2.put(r2Key, arrayBuffer, {
            httpMetadata: {
                contentType: file.type || "application/octet-stream",
            },
            customMetadata: {
                originalName: file.name,
                documentId,
                conversationId: conversationId || "",
            },
        })

        let extractedText = ""
        const status: "ready" | "image" | "processing" | "error" = isImage ? "image" : "ready"

        if (isText) {
            try {
                const decoder = new TextDecoder("utf-8")
                extractedText = decoder.decode(arrayBuffer)

                // If Vectorize and AI bindings are available, index the text
                const appEnv = env as unknown as AppEnv
                const ai = appEnv.AI
                const vectorize = appEnv.VECTORIZE
                if (ai && vectorize && extractedText.trim()) {
                    try {
                        await indexDocument(
                            ai,
                            vectorize,
                            documentId,
                            file.name,
                            extractedText,
                            conversationId
                        )
                    } catch (ragErr) {
                        console.warn(
                            "Could not index document in Vectorize (likely placeholder config):",
                            ragErr
                        )
                    }
                }
            } catch (decodeErr) {
                console.warn("Failed to decode text file:", decodeErr)
            }
        }

        // Record document in D1
        try {
            await createDocument({
                id: documentId,
                conversation_id: conversationId,
                name: file.name,
                r2_key: r2Key,
                mime: file.type || "application/octet-stream",
                size: file.size,
                status,
                created_at: Date.now(),
            })
        } catch (dbErr: unknown) {
            const msg = dbErr instanceof Error ? dbErr.message : String(dbErr)
            console.warn("D1 could not record document:", msg)
        }

        return Response.json({
            id: documentId,
            conversation_id: conversationId,
            name: file.name,
            mime: file.type || "application/octet-stream",
            size: file.size,
            r2_key: r2Key,
            isImage,
            url: `/api/files/${documentId}`,
            r2_url: `/api/r2?key=${encodeURIComponent(r2Key)}`,
            status,
            textContent: extractedText ? extractedText.slice(0, 4000) : undefined, // Provide preview/context
        })
    } catch (error: unknown) {
        console.error("Error in POST /api/upload:", error)
        const isBindingError =
            error instanceof Error &&
            (error.name === "R2BindingError" ||
                error.name === "DatabaseBindingError" ||
                error.message.includes("REPLACE_WITH_"))
        const errorMessage = error instanceof Error ? error.message : "File upload failed"

        return Response.json(
            {
                error: errorMessage,
                isBindingError: Boolean(isBindingError),
            },
            { status: isBindingError ? 503 : 500 }
        )
    }
}
