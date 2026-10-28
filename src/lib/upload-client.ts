import { getAuthHeaders } from "./auth-client"
import {
    DocumentItem,
    UploadInitRequest,
    UploadInitResponse,
    UploadCompleteRequest,
    UploadCompleteResponse,
} from "./types"

export interface DirectUploadResult {
    document: DocumentItem
    isPdf: boolean
    progressUrl?: string
}

/**
 * Upload a file directly using the robust 3-stage pipeline:
 * 1. Initialize upload (validates size/MIME, allocates server documentId & R2 key, generates presigned URL or direct stream URL)
 * 2. Upload file bytes directly (to R2 presigned URL or streaming endpoint without Worker memory buffering)
 * 3. Complete upload (validates R2 object, verifies PDF magic bytes, idempotently initializes D1, and triggers Workflow)
 */
export async function uploadFileDirect(
    file: File,
    conversationId?: string | null
): Promise<DirectUploadResult> {
    const authHeaders = getAuthHeaders()

    // Stage 1: Initialize
    const initPayload: UploadInitRequest = {
        filename: file.name,
        mime: file.type,
        size: file.size,
        conversationId: conversationId || null,
    }

    const initRes = await fetch("/api/upload/init", {
        method: "POST",
        headers: getAuthHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify(initPayload),
    })

    if (!initRes.ok) {
        const errJson = (await initRes.json().catch(() => ({}))) as { error?: string }
        throw new Error(errJson.error || `Upload initialization failed (${initRes.status})`)
    }

    const initData = (await initRes.json()) as UploadInitResponse
    const { mode, documentId, uploadUrl, headers: customHeaders } = initData

    // Stage 2: Direct Upload
    const uploadHeaders: Record<string, string> = {
        ...(customHeaders || {}),
        "Content-Type": file.type || "application/octet-stream",
    }

    // Include auth header if uploading through the streaming fallback route
    if (mode === "stream") {
        Object.assign(uploadHeaders, authHeaders)
    }

    const uploadRes = await fetch(uploadUrl, {
        method: "PUT",
        headers: uploadHeaders,
        body: file,
    })

    if (!uploadRes.ok) {
        const errText = await uploadRes.text().catch(() => "")
        throw new Error(
            `Failed to upload file bytes (${uploadRes.status}): ${errText || "Storage upload rejected."}`
        )
    }

    // Stage 3: Complete
    const completePayload: UploadCompleteRequest = {
        documentId,
        filename: file.name,
        conversationId: conversationId || null,
        mime: file.type,
    }

    const completeRes = await fetch("/api/upload/complete", {
        method: "POST",
        headers: getAuthHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify(completePayload),
    })

    if (!completeRes.ok) {
        const errJson = (await completeRes.json().catch(() => ({}))) as { error?: string }
        throw new Error(errJson.error || `Upload completion failed (${completeRes.status})`)
    }

    const completeData = (await completeRes.json()) as UploadCompleteResponse
    return completeData
}
