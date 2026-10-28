/**
 * Helper utilities for detecting YouTube video metadata and original audio language.
 * Inspects YouTube oEmbed, watch page caption tracks (specifically ASR tracks), and Unicode script.
 */

export interface YouTubeMetadataDetection {
    lang: string
    baseLang: string
    title?: string
    authorName?: string
    isAsr?: boolean
}

const BENGALI_SCRIPT_REGEX = /[\u0980-\u09FF]/
const DEVANAGARI_SCRIPT_REGEX = /[\u0900-\u097F]/
const ARABIC_SCRIPT_REGEX = /[\u0600-\u06FF]/
const JAPANESE_SCRIPT_REGEX = /[\u3040-\u30FF\u31F0-\u31FF]/
const KOREAN_SCRIPT_REGEX = /[\uAC00-\uD7AF\u1100-\u11FF]/
const CHINESE_SCRIPT_REGEX = /[\u4E00-\u9FFF]/
const CYRILLIC_SCRIPT_REGEX = /[\u0400-\u04FF]/

/**
 * Normalizes language codes like "bn-BD" -> "bn", "en-US" -> "en".
 */
export function normalizeLanguageCode(code: string): { lang: string; baseLang: string } {
    if (!code || typeof code !== "string") {
        return { lang: "en", baseLang: "en" }
    }
    const clean = code.trim().toLowerCase()
    const base = clean.split("-")[0].split("_")[0]
    return { lang: clean, baseLang: base }
}

/**
 * Checks if text contains Bengali script characters.
 */
export function isBengaliText(text: string): boolean {
    return Boolean(text && BENGALI_SCRIPT_REGEX.test(text))
}

/**
 * Detects language from script content when no metadata is available.
 */
export function detectLanguageFromScript(text: string): string | null {
    if (!text) return null
    if (BENGALI_SCRIPT_REGEX.test(text)) return "bn"
    if (DEVANAGARI_SCRIPT_REGEX.test(text)) return "hi"
    if (ARABIC_SCRIPT_REGEX.test(text)) return "ar"
    if (JAPANESE_SCRIPT_REGEX.test(text)) return "ja"
    if (KOREAN_SCRIPT_REGEX.test(text)) return "ko"
    if (CHINESE_SCRIPT_REGEX.test(text)) return "zh"
    if (CYRILLIC_SCRIPT_REGEX.test(text)) return "ru"
    return null
}

/**
 * Fetches public oEmbed metadata for a YouTube video.
 * Very fast, no authentication needed, never blocked by bot detection.
 */
export async function fetchYouTubeOembed(
    videoId: string,
    signal?: AbortSignal
): Promise<{ title?: string; authorName?: string } | null> {
    try {
        const url = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&format=json`
        const res = await fetch(url, {
            signal: signal
                ? AbortSignal.any([signal, AbortSignal.timeout(3000)])
                : AbortSignal.timeout(3000),
            headers: { Accept: "application/json" },
        })
        if (!res.ok) return null
        const data = (await res.json()) as { title?: string; author_name?: string }
        return {
            title: data.title?.trim() || undefined,
            authorName: data.author_name?.trim() || undefined,
        }
    } catch {
        return null
    }
}

/**
 * Detects the original audio language of a YouTube video.
 *
 * Primary source of truth:
 * YouTube's Automatic Speech Recognition (ASR) caption track (vssId starting with "a." or kind="asr").
 * YouTube's speech recognition model ONLY generates captions in the actual language spoken in the video audio.
 * Secondary sources: defaultAudioLanguage, default caption track, and title script detection (e.g. Bengali Unicode).
 */
export async function detectYouTubeVideoLanguage(
    videoId: string,
    options: {
        signal?: AbortSignal
        timeoutMs?: number
    } = {}
): Promise<YouTubeMetadataDetection> {
    let resolvedTitle: string | undefined
    let resolvedAuthor: string | undefined
    let rawLang: string | null = null
    let isAsr = false

    // Step 1: Query oEmbed for authoritative title
    const oembedPromise = fetchYouTubeOembed(videoId, options.signal).then((oembed) => {
        if (oembed?.title) resolvedTitle = oembed.title
        if (oembed?.authorName) resolvedAuthor = oembed.authorName
    })

    // Step 2: Query YouTube watch page for captionTracks / ASR language / defaultAudioLanguage
    const watchPagePromise = (async () => {
        try {
            const timeoutMs = options.timeoutMs || 3500
            const controller = new AbortController()
            const timer = setTimeout(() => controller.abort(), timeoutMs)
            const combinedSignal = options.signal
                ? AbortSignal.any([options.signal, controller.signal])
                : controller.signal

            const res = await fetch(
                `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`,
                {
                    headers: {
                        "User-Agent":
                            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                        "Accept-Language": "en-US,en;q=0.9",
                    },
                    signal: combinedSignal,
                }
            )
            clearTimeout(timer)

            if (!res.ok) return

            const html = await res.text()

            // 1. Look for captionTracks JSON array in initial player response
            const captionMatch = html.match(/"captionTracks":\s*(\[[\s\S]*?\])/)
            if (captionMatch) {
                try {
                    interface TrackRaw {
                        languageCode?: string
                        vssId?: string
                        kind?: string
                    }
                    const tracks = JSON.parse(captionMatch[1]) as TrackRaw[]

                    // Priority 1: ASR track (speech-to-text language auto-detected by YouTube from the audio)
                    const asrTrack = tracks.find(
                        (t) => t.kind === "asr" || (t.vssId && t.vssId.startsWith("a."))
                    )
                    if (asrTrack?.languageCode) {
                        rawLang = asrTrack.languageCode
                        isAsr = true
                        return
                    }

                    // Priority 2: First native/manual caption track
                    if (tracks.length > 0 && tracks[0].languageCode) {
                        rawLang = tracks[0].languageCode
                        return
                    }
                } catch {
                    // Ignore JSON parse failure
                }
            }

            // 2. Look for defaultAudioLanguage in videoDetails
            const audioLangMatch = html.match(/"defaultAudioLanguage":\s*"([^"]+)"/)
            if (audioLangMatch && audioLangMatch[1]) {
                rawLang = audioLangMatch[1]
                return
            }
        } catch {
            // Watch page fetch failure is non-fatal
        }
    })()

    await Promise.allSettled([oembedPromise, watchPagePromise])

    // Step 3: Script detection fallback (e.g. Bengali Unicode characters in title)
    if (!rawLang && resolvedTitle) {
        const scriptLang = detectLanguageFromScript(resolvedTitle)
        if (scriptLang) {
            rawLang = scriptLang
        }
    }

    // Step 4: If title is in Bengali but rawLang was detected as English (e.g. manual English subtitle track existed),
    // give strong weight to Bengali if Bengali script is prevalent in the title
    if (
        resolvedTitle &&
        isBengaliText(resolvedTitle) &&
        rawLang &&
        rawLang.startsWith("en") &&
        !isAsr
    ) {
        rawLang = "bn"
    }

    const { lang, baseLang } = normalizeLanguageCode(rawLang || "en")

    return {
        lang,
        baseLang,
        title: resolvedTitle,
        authorName: resolvedAuthor,
        isAsr,
    }
}
