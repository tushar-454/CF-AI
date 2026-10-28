/**
 * Lightweight, zero-dependency AWS SigV4 presigned PUT URL generator for Cloudflare R2.
 * Powered by Web Crypto API (crypto.subtle), fully compatible with Cloudflare Workers runtime.
 */

async function hmacSha256(key: Uint8Array, data: string): Promise<Uint8Array> {
    const cryptoKey = await crypto.subtle.importKey(
        "raw",
        key as unknown as ArrayBuffer,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
    )
    const signature = await crypto.subtle.sign(
        "HMAC",
        cryptoKey,
        new TextEncoder().encode(data) as unknown as ArrayBuffer
    )
    return new Uint8Array(signature)
}

function toHex(buffer: Uint8Array): string {
    return Array.from(buffer)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("")
}

export interface PresignPutOptions {
    endpoint?: string
    accountId?: string
    bucketName: string
    objectKey: string
    accessKeyId: string
    secretAccessKey: string
    contentType?: string
    expiresInSeconds?: number
}

/**
 * Generate a short-lived presigned PUT URL for direct browser-to-R2 upload.
 */
export async function createR2PresignedPutUrl(options: PresignPutOptions): Promise<string> {
    const { bucketName, objectKey, accessKeyId, secretAccessKey, expiresInSeconds = 900 } = options

    const endpoint =
        options.endpoint?.replace(/\/$/, "") ||
        (options.accountId ? `https://${options.accountId}.r2.cloudflarestorage.com` : undefined)

    if (!endpoint) {
        throw new Error("Missing R2 endpoint or accountId for generating presigned URL.")
    }

    const host = new URL(endpoint).host
    const region = "auto"
    const service = "s3"

    const now = new Date()
    const isoDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "") // YYYYMMDDTHHmmssZ
    const dateStamp = isoDate.slice(0, 8) // YYYYMMDD

    const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`
    const canonicalUri = `/${encodeURIComponent(bucketName)}/${encodeURIComponent(objectKey).replace(/%2F/g, "/")}`

    const queryParams: Record<string, string> = {
        "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
        "X-Amz-Credential": `${accessKeyId}/${credentialScope}`,
        "X-Amz-Date": isoDate,
        "X-Amz-Expires": String(expiresInSeconds),
        "X-Amz-SignedHeaders": "host",
    }

    const sortedQueryString = Object.keys(queryParams)
        .sort()
        .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(queryParams[k])}`)
        .join("&")

    const canonicalHeaders = `host:${host}\n`
    const signedHeaders = "host"
    const payloadHash = "UNSIGNED-PAYLOAD"

    const canonicalRequest = [
        "PUT",
        canonicalUri,
        sortedQueryString,
        canonicalHeaders,
        signedHeaders,
        payloadHash,
    ].join("\n")

    const canonicalRequestHashBuffer = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(canonicalRequest) as unknown as ArrayBuffer
    )
    const canonicalRequestHash = toHex(new Uint8Array(canonicalRequestHashBuffer))

    const stringToSign = ["AWS4-HMAC-SHA256", isoDate, credentialScope, canonicalRequestHash].join(
        "\n"
    )

    // Derive signing key
    const kDate = await hmacSha256(new TextEncoder().encode(`AWS4${secretAccessKey}`), dateStamp)
    const kRegion = await hmacSha256(kDate, region)
    const kService = await hmacSha256(kRegion, service)
    const kSigning = await hmacSha256(kService, "aws4_request")

    const signature = toHex(await hmacSha256(kSigning, stringToSign))

    return `${endpoint}${canonicalUri}?${sortedQueryString}&X-Amz-Signature=${signature}`
}
