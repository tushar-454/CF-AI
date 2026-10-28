/**
 * YouTube URL parser and canonical video ID validator.
 * Enforces hostname allowlisting, canonical URL formation, and strict ID extraction.
 */

const ALLOWED_YOUTUBE_HOSTS = new Set([
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "music.youtube.com",
    "youtu.be",
])

const VIDEO_ID_REGEX = /^[a-zA-Z0-9_-]{11}$/

export interface ParsedYouTubeUrl {
    isValid: true
    videoId: string
    canonicalUrl: string
}

export interface InvalidYouTubeUrl {
    isValid: false
    error: string
}

export type YouTubeUrlParseResult = ParsedYouTubeUrl | InvalidYouTubeUrl

/**
 * Validates a YouTube URL and extracts its canonical 11-character video ID.
 * Supports standard watch URLs, short youtu.be links, Shorts, and embed URLs.
 * Rejects playlist-only URLs, invalid domains, and malformed structures.
 */
export function parseYouTubeUrl(rawUrl: string): YouTubeUrlParseResult {
    if (!rawUrl || typeof rawUrl !== "string") {
        return { isValid: false, error: "URL must be a non-empty string." }
    }

    const trimmed = rawUrl.trim()

    // Add protocol if missing to enable standard URL parsing
    const urlToParse =
        trimmed.startsWith("http://") || trimmed.startsWith("https://")
            ? trimmed
            : `https://${trimmed}`

    let parsed: URL
    try {
        parsed = new URL(urlToParse)
    } catch {
        return { isValid: false, error: "Malformed URL format." }
    }

    // Hostname normalization and allowlist check
    const host = parsed.hostname.toLowerCase().replace(/^\.+/, "")
    if (!ALLOWED_YOUTUBE_HOSTS.has(host)) {
        return {
            isValid: false,
            error: `Unsupported domain "${parsed.hostname}". Only official YouTube URLs are accepted.`,
        }
    }

    let extractedId: string | null = null

    if (host === "youtu.be") {
        // Path format: /VIDEO_ID
        const pathSegments = parsed.pathname.split("/").filter(Boolean)
        if (pathSegments.length > 0) {
            extractedId = pathSegments[0]
        }
    } else {
        const pathname = parsed.pathname

        if (pathname === "/watch") {
            // Format: /watch?v=VIDEO_ID
            extractedId = parsed.searchParams.get("v")
        } else if (pathname.startsWith("/shorts/")) {
            // Format: /shorts/VIDEO_ID
            const segments = pathname.split("/").filter(Boolean)
            if (segments.length >= 2) {
                extractedId = segments[1]
            }
        } else if (pathname.startsWith("/embed/")) {
            // Format: /embed/VIDEO_ID
            const segments = pathname.split("/").filter(Boolean)
            if (segments.length >= 2) {
                extractedId = segments[1]
            }
        } else if (pathname.startsWith("/v/")) {
            // Format: /v/VIDEO_ID
            const segments = pathname.split("/").filter(Boolean)
            if (segments.length >= 2) {
                extractedId = segments[1]
            }
        } else if (pathname.startsWith("/live/")) {
            // Format: /live/VIDEO_ID
            const segments = pathname.split("/").filter(Boolean)
            if (segments.length >= 2) {
                extractedId = segments[1]
            }
        } else if (pathname === "/playlist" && !parsed.searchParams.get("v")) {
            return {
                isValid: false,
                error: "Playlist-only URLs are not supported. Please provide a specific video URL.",
            }
        }
    }

    if (!extractedId || !VIDEO_ID_REGEX.test(extractedId)) {
        return {
            isValid: false,
            error: "Could not extract a valid 11-character YouTube video ID.",
        }
    }

    return {
        isValid: true,
        videoId: extractedId,
        canonicalUrl: `https://www.youtube.com/watch?v=${extractedId}`,
    }
}

/**
 * Extracts a canonical 11-character video ID from a YouTube URL if valid, or null.
 */
export function extractYouTubeVideoId(rawUrl: string): string | null {
    const res = parseYouTubeUrl(rawUrl)
    return res.isValid ? res.videoId : null
}

/**
 * Validates a YouTube URL and returns a validation object.
 */
export function validateYouTubeUrl(rawUrl: string): {
    valid: boolean
    videoId?: string
    canonicalUrl?: string
    error?: string
} {
    const res = parseYouTubeUrl(rawUrl)
    if (res.isValid) {
        return {
            valid: true,
            videoId: res.videoId,
            canonicalUrl: res.canonicalUrl,
        }
    }
    return {
        valid: false,
        error: res.error,
    }
}

/**
 * Builds a standard canonical watch URL from a video ID.
 */
export function getCanonicalYouTubeUrl(videoId: string): string {
    return `https://www.youtube.com/watch?v=${videoId}`
}

/**
 * Checks if a string is a valid 11-character YouTube video ID.
 */
export function isValidYouTubeVideoId(videoId: string): boolean {
    return typeof videoId === "string" && VIDEO_ID_REGEX.test(videoId)
}
