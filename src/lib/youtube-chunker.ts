/**
 * YouTube transcript chunking, timestamp formatting, and binary search utilities.
 */

import { YOUTUBE_CHAT_CONFIG } from "./youtube-model-config"
import type { TranscriptSegment, YoutubeChunk } from "./youtube-types"

/**
 * Formats a duration in seconds to standard MM:SS or HH:MM:SS format.
 */
export function formatTimestamp(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds < 0) {
        return "00:00"
    }

    const totalSecs = Math.floor(seconds)
    const hours = Math.floor(totalSecs / 3600)
    const minutes = Math.floor((totalSecs % 3600) / 60)
    const remainingSecs = totalSecs % 60

    const paddedMins = String(minutes).padStart(2, "0")
    const paddedSecs = String(remainingSecs).padStart(2, "0")

    if (hours > 0) {
        return `${hours}:${paddedMins}:${paddedSecs}`
    }
    return `${paddedMins}:${paddedSecs}`
}

/**
 * Parses timestamps in various formats (MM:SS, HH:MM:SS, 120s, 2m15s) into seconds.
 */
export function parseTimestamp(input: string): number | null {
    if (!input || typeof input !== "string") return null
    const clean = input.trim().replace(/^\[|\]$/g, "")

    // Format: HH:MM:SS or MM:SS
    if (clean.includes(":")) {
        const parts = clean.split(":").map((p) => parseFloat(p))
        if (parts.some((p) => Number.isNaN(p) || p < 0)) return null

        if (parts.length === 2) {
            const [minutes, seconds] = parts
            return minutes * 60 + seconds
        }
        if (parts.length === 3) {
            const [hours, minutes, seconds] = parts
            return hours * 3600 + minutes * 60 + seconds
        }
        return null
    }

    // Format: 120s
    if (/^\d+(\.\d+)?s$/i.test(clean)) {
        const val = parseFloat(clean.slice(0, -1))
        return Number.isFinite(val) && val >= 0 ? val : null
    }

    // Pure numeric seconds
    const numeric = parseFloat(clean)
    if (Number.isFinite(numeric) && numeric >= 0) {
        return numeric
    }

    return null
}

/**
 * Chunks ordered transcript segments into retrieval chunks (~800 chars, ~100 overlap).
 * Preserves the exact start and end timestamps from the underlying contiguous segments.
 */
export function chunkTranscriptSegments(
    videoId: string,
    segments: TranscriptSegment[],
    chunkSize: number = YOUTUBE_CHAT_CONFIG.chunkSize,
    chunkOverlap: number = YOUTUBE_CHAT_CONFIG.chunkOverlap
): YoutubeChunk[] {
    if (!segments || segments.length === 0) return []

    const chunks: YoutubeChunk[] = []
    let currentSegmentIndex = 0

    while (currentSegmentIndex < segments.length) {
        const chunkSegments: TranscriptSegment[] = []
        let currentLength = 0
        let nextIndex = currentSegmentIndex

        // Accumulate contiguous segments up to target chunkSize
        while (nextIndex < segments.length) {
            const seg = segments[nextIndex]
            chunkSegments.push(seg)
            currentLength += seg.text.length + 1 // + 1 for space

            if (currentLength >= chunkSize) {
                break
            }
            nextIndex++
        }

        const startSeconds = chunkSegments[0].startSeconds
        const endSeconds = chunkSegments[chunkSegments.length - 1].endSeconds
        const text = chunkSegments
            .map((s) => s.text)
            .join(" ")
            .trim()

        if (text) {
            chunks.push({
                id: `${videoId}_${chunks.length}`,
                videoId,
                chunkIndex: chunks.length,
                startSeconds,
                endSeconds,
                text,
            })
        }

        // Advance currentSegmentIndex with overlap consideration
        if (nextIndex >= segments.length - 1) {
            break
        }

        // Calculate overlap: step back from nextIndex so approximately chunkOverlap chars overlap
        let overlapChars = 0
        let stepBackIndex = nextIndex

        while (stepBackIndex > currentSegmentIndex && overlapChars < chunkOverlap) {
            overlapChars += segments[stepBackIndex].text.length + 1
            stepBackIndex--
        }

        currentSegmentIndex = Math.max(currentSegmentIndex + 1, stepBackIndex + 1)
    }

    return chunks
}

export const chunkTranscript = chunkTranscriptSegments

/**
 * Binary search to efficiently identify the active transcript segment for a given playback time.
 * Runs in O(log N) time, preventing layout lag on large video transcripts.
 */
export function findActiveSegmentIndex(
    segments: TranscriptSegment[],
    currentTimeSeconds: number
): number {
    if (!segments || segments.length === 0) return -1
    if (currentTimeSeconds < 0) return 0

    let low = 0
    let high = segments.length - 1
    let bestMatch = -1

    while (low <= high) {
        const mid = Math.floor((low + high) / 2)
        const seg = segments[mid]

        if (currentTimeSeconds >= seg.startSeconds && currentTimeSeconds < seg.endSeconds) {
            return mid
        }

        if (currentTimeSeconds < seg.startSeconds) {
            high = mid - 1
        } else {
            bestMatch = mid
            low = mid + 1
        }
    }

    return bestMatch
}
