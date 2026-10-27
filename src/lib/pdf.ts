import { extractText, getDocumentProxy } from "unpdf"

/**
 * Checks whether the given MIME type or filename indicates a PDF document.
 */
export function isPdfFile(mime: string, filename: string): boolean {
    if (mime && mime.toLowerCase() === "application/pdf") {
        return true
    }
    const ext = filename.split(".").pop()?.toLowerCase()
    return ext === "pdf"
}

/**
 * Extract selectable plain text from a PDF document buffer.
 * Powered by unpdf (serverless / edge-optimized PDF.js build with zero DOM/canvas dependencies).
 */
export async function extractPdfText(
    pdfBuffer: ArrayBuffer | Uint8Array,
    aiBinding?: unknown
): Promise<string> {
    const uint8 = pdfBuffer instanceof Uint8Array ? pdfBuffer : new Uint8Array(pdfBuffer)
    if (uint8.byteLength === 0) {
        return ""
    }

    // Attempt 1: unpdf extraction
    try {
        const pdf = await getDocumentProxy(uint8)
        const { text } = await extractText(pdf, { mergePages: true })
        if (typeof text === "string" && text.trim().length > 0) {
            // Clean up redundant blank lines or null characters
            return text
                .split("\0")
                .join("")
                .replace(/\r\n/g, "\n")
                .replace(/\n{3,}/g, "\n\n")
                .trim()
        }
    } catch (unpdfErr) {
        console.warn("unpdf text extraction error:", unpdfErr)
    }

    // Attempt 2: Workers AI toMarkdown fallback if binding provides document conversion
    if (aiBinding && typeof (aiBinding as { toMarkdown?: unknown }).toMarkdown === "function") {
        try {
            const ai = aiBinding as {
                toMarkdown: (
                    buf: ArrayBuffer,
                    opts?: unknown
                ) => Promise<{ content?: string; text?: string }>
            }
            const res = await ai.toMarkdown(uint8.buffer as ArrayBuffer, {
                conversionOptions: {
                    output: { format: "text" },
                },
            })
            const parsed = res?.content || res?.text || ""
            if (parsed.trim().length > 0) {
                return parsed.trim()
            }
        } catch (aiErr) {
            console.warn("Workers AI toMarkdown fallback error:", aiErr)
        }
    }

    return ""
}
