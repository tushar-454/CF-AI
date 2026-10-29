import { extractImages, extractText, getDocumentProxy } from "unpdf"
import type { WorkersAi } from "./types"

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

export interface PdfPageContent {
    pageNumber: number // 1-indexed (1, 2, 3...)
    text: string
}

export interface PageQualityAssessment {
    isUsable: boolean
    reason: string
    charCount: number
    wordCount: number
    qualityScore: number
}

export interface PdfExtractionOptions {
    ai?: WorkersAi | unknown
    enableOcr?: boolean
    maxOcrPages?: number
    ocrConcurrency?: number
    minPageTextThreshold?: number
}

export interface ExtractedDocumentResult {
    pages: PdfPageContent[]
    totalPages: number
    extractionMode: "text" | "ocr" | "mixed"
    ocrPagesCount: number
    contentHash: string
    details?: {
        ocrAttemptedPages: number
        ocrSuccessfulPages: number
        ocrFailedPages: number
        skippedOcrPages: number
    }
}

export const VISION_OCR_MODEL_ID = "@cf/meta/llama-3.2-11b-vision-instruct"

/**
 * Evaluates the quality and usability of extracted page text.
 * Distinguishes genuine usable text from whitespace, sparse fragments,
 * corrupted fonts, and repetitive or garbled character noise.
 */
export function evaluatePageTextQuality(rawText: string): PageQualityAssessment {
    const cleaned = (rawText || "")
        .split("\0")
        .join("")
        .replace(/\r\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim()

    if (!cleaned) {
        return { isUsable: false, reason: "empty", charCount: 0, wordCount: 0, qualityScore: 0 }
    }

    const nonSpaceChars = cleaned.replace(/\s/g, "")
    const charCount = nonSpaceChars.length
    const words = cleaned.split(/\s+/).filter((w) => w.length > 0)
    const wordCount = words.length

    // Sparse text threshold: solitary numbers, page numbers, single-word footer fragments
    if (charCount < 40 || wordCount < 6) {
        return {
            isUsable: false,
            reason: "sparse_text",
            charCount,
            wordCount,
            qualityScore: 0.2,
        }
    }

    // Replacement characters (\uFFFD) indicating corrupted decoding
    const replacementCount = (cleaned.match(/\uFFFD/g) || []).length
    if (replacementCount / charCount > 0.05) {
        return {
            isUsable: false,
            reason: "replacement_chars",
            charCount,
            wordCount,
            qualityScore: 0.1,
        }
    }

    // Unicode alphanumeric ratio (letters and digits across any language)
    const alphaNumMatches = nonSpaceChars.match(/[\p{L}\p{N}]/gu) || []
    const alphaNumRatio = alphaNumMatches.length / charCount
    if (alphaNumRatio < 0.45) {
        return {
            isUsable: false,
            reason: "low_alphanumeric_ratio",
            charCount,
            wordCount,
            qualityScore: 0.1,
        }
    }

    // Excessive single-character repetition (e.g. ............. or aaaaaaaaa)
    const charFreq: Record<string, number> = {}
    for (const ch of nonSpaceChars) {
        charFreq[ch] = (charFreq[ch] || 0) + 1
    }
    const maxFreq = Math.max(...Object.values(charFreq))
    if (charCount >= 30 && maxFreq / charCount > 0.4) {
        return {
            isUsable: false,
            reason: "excessive_char_repetition",
            charCount,
            wordCount,
            qualityScore: 0.1,
        }
    }

    // Word length anomaly check (e.g. lost space separators resulting in 100-character unspaced strings)
    const totalWordLen = words.reduce((acc, w) => acc + w.length, 0)
    const avgWordLen = totalWordLen / wordCount
    if (avgWordLen > 30 || avgWordLen < 1.5) {
        return {
            isUsable: false,
            reason: "word_length_anomaly",
            charCount,
            wordCount,
            qualityScore: 0.2,
        }
    }

    return { isUsable: true, reason: "usable_text", charCount, wordCount, qualityScore: 1.0 }
}

/**
 * Normalizes text for comparison without punctuation and case sensitivity.
 */
export function normalizeForComparison(str: string): string {
    return (str || "")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .replace(/\s+/g, " ")
        .trim()
}

/**
 * Merges embedded text with OCR transcribed text on a page without duplicating content.
 */
export function mergePageText(embeddedText: string, ocrText: string): string {
    const cleanEmbed = (embeddedText || "")
        .split("\0")
        .join("")
        .replace(/\r\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim()

    const cleanOcr = (ocrText || "")
        .split("\0")
        .join("")
        .replace(/\r\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim()

    if (!cleanEmbed) return cleanOcr
    if (!cleanOcr) return cleanEmbed

    const normEmbed = normalizeForComparison(cleanEmbed)
    const normOcr = normalizeForComparison(cleanOcr)

    // Exact match or full containment
    if (normEmbed === normOcr || normEmbed.includes(normOcr)) {
        return cleanEmbed
    }

    // OCR contains the entire embedded text (e.g. OCR scanned whole page including embedded header)
    if (normOcr.includes(normEmbed)) {
        return cleanOcr
    }

    // Split into paragraphs for block-level deduplication
    const embedParas = cleanEmbed
        .split(/\n\s*\n/)
        .map((p) => p.trim())
        .filter(Boolean)
    const ocrParas = cleanOcr
        .split(/\n\s*\n/)
        .map((p) => p.trim())
        .filter(Boolean)

    const normEmbedParas = embedParas.map((p) => normalizeForComparison(p))

    const uniqueOcrParas: string[] = []
    for (const para of ocrParas) {
        const normP = normalizeForComparison(para)
        if (!normP || normP.length < 5) continue

        // Check if paragraph is duplicate or substantially overlaps with an existing paragraph
        const isDuplicate = normEmbedParas.some((normE) => {
            if (normE === normP) return true
            if (normE.includes(normP) || normP.includes(normE)) {
                const minLen = Math.min(normE.length, normP.length)
                if (minLen >= 15) return true
            }
            return false
        })

        if (!isDuplicate) {
            uniqueOcrParas.push(para)
        }
    }

    if (uniqueOcrParas.length === 0) {
        return cleanEmbed
    }

    return `${cleanEmbed}\n\n${uniqueOcrParas.join("\n\n")}`
}

/**
 * Filter candidate images: rejects tiny icons, bullets, dividers, extreme aspect ratios.
 */
export function isCandidateOcrImage(img: {
    width: number
    height: number
    channels: number
}): boolean {
    const { width, height } = img
    if (!width || !height || width <= 0 || height <= 0) return false

    // Skip small icons, bullets, spacers (e.g. < 40px)
    if (width < 40 || height < 40) return false

    // Skip small total pixel area (smaller than 80x80 = 6400 pixels)
    const area = width * height
    if (area < 6400) return false

    // Skip extreme aspect ratios (lines, dividers, borders, banners)
    const aspect = width / height
    if (aspect > 15 || aspect < 1 / 15) return false

    return true
}

/**
 * Fast deterministic hash for image deduplication across pages (e.g. logos, headers, watermarks).
 */
export function computeImageHash(
    width: number,
    height: number,
    channels: number,
    data: Uint8ClampedArray | Uint8Array
): string {
    let hash = 0x811c9dc5
    hash = (hash ^ (width & 0xffff)) * 0x01000193
    hash = (hash ^ (height & 0xffff)) * 0x01000193
    hash = (hash ^ channels) * 0x01000193

    // Sample pixels evenly: up to 2048 samples
    const step = Math.max(1, Math.floor(data.length / 2048))
    for (let i = 0; i < data.length; i += step) {
        hash = (hash ^ data[i]) * 0x01000193
    }
    return `${width}x${height}_${channels}_${(hash >>> 0).toString(16)}`
}

// Pre-computed CRC32 lookup table for fast PNG chunk checksum calculation
const CRC_TABLE = new Uint32Array(256)
for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    CRC_TABLE[n] = c >>> 0
}

function calculateCrc32(buf: Uint8Array, offset: number, len: number): number {
    let c = 0xffffffff
    for (let i = offset; i < offset + len; i++) {
        c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
    }
    return (c ^ 0xffffffff) >>> 0
}

/**
 * Pure JavaScript PNG encoder using standard Web API CompressionStream('deflate').
 * Compatible with Cloudflare Workers runtime and Node.js without native canvas bindings.
 */
export async function encodeRawToPng(
    width: number,
    height: number,
    channels: number,
    data: Uint8ClampedArray | Uint8Array
): Promise<Uint8Array> {
    const stride = width * channels
    // Each row in uncompressed PNG has 1 filter byte prefix (0 = None) followed by pixel bytes
    const rawScanlines = new Uint8Array(height * (1 + stride))
    for (let y = 0; y < height; y++) {
        rawScanlines[y * (1 + stride)] = 0 // Filter 0
        rawScanlines.set(data.subarray(y * stride, (y + 1) * stride), y * (1 + stride) + 1)
    }

    // Compress scanlines with standard zlib deflate stream supported natively by modern Web APIs
    const cs = new CompressionStream("deflate")
    const writer = cs.writable.getWriter()
    writer.write(rawScanlines)
    writer.close()

    const reader = cs.readable.getReader()
    const idatChunks: Uint8Array[] = []
    let idatDataLen = 0
    while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) {
            idatChunks.push(value)
            idatDataLen += value.length
        }
    }

    // Merge IDAT chunks
    const idatData = new Uint8Array(idatDataLen)
    let idatOffset = 0
    for (const chunk of idatChunks) {
        idatData.set(chunk, idatOffset)
        idatOffset += chunk.length
    }

    // Total PNG file size:
    // Signature: 8 bytes
    // IHDR: 4 (len) + 4 (type) + 13 (data) + 4 (crc) = 25 bytes
    // IDAT: 4 (len) + 4 (type) + idatDataLen + 4 (crc) = 12 + idatDataLen
    // IEND: 4 (len) + 4 (type) + 0 + 4 (crc) = 12 bytes
    const totalLength = 8 + 25 + (12 + idatDataLen) + 12
    const png = new Uint8Array(totalLength)
    const view = new DataView(png.buffer)

    // PNG signature: [137, 80, 78, 71, 13, 10, 26, 10]
    png.set([137, 80, 78, 71, 13, 10, 26, 10], 0)

    // IHDR chunk
    let pos = 8
    view.setUint32(pos, 13) // IHDR length = 13
    pos += 4
    const ihdrStart = pos
    png.set([73, 72, 68, 82], pos) // 'IHDR'
    pos += 4
    view.setUint32(pos, width)
    pos += 4
    view.setUint32(pos, height)
    pos += 4
    png[pos++] = 8 // Bit depth: 8
    // Color type: 0 = Grayscale (1 ch), 2 = RGB (3 ch), 6 = RGBA (4 ch)
    png[pos++] = channels === 1 ? 0 : channels === 3 ? 2 : 6
    png[pos++] = 0 // Deflate compression
    png[pos++] = 0 // Adaptive filtering
    png[pos++] = 0 // Non-interlaced
    const ihdrCrc = calculateCrc32(png, ihdrStart, 17)
    view.setUint32(pos, ihdrCrc)
    pos += 4

    // IDAT chunk
    view.setUint32(pos, idatDataLen)
    pos += 4
    const idatStart = pos
    png.set([73, 68, 65, 84], pos) // 'IDAT'
    pos += 4
    png.set(idatData, pos)
    pos += idatDataLen
    const idatCrc = calculateCrc32(png, idatStart, 4 + idatDataLen)
    view.setUint32(pos, idatCrc)
    pos += 4

    // IEND chunk
    view.setUint32(pos, 0)
    pos += 4
    const iendStart = pos
    png.set([73, 69, 78, 68], pos) // 'IEND'
    pos += 4
    const iendCrc = calculateCrc32(png, iendStart, 4)
    view.setUint32(pos, iendCrc)
    pos += 4

    return png
}

/**
 * Execute tasks with bounded concurrency using a Promise pool.
 */
async function runWithConcurrency<T, R>(
    items: T[],
    concurrency: number,
    fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
    if (items.length === 0) return []
    const results: R[] = new Array(items.length)
    let nextIndex = 0

    const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (nextIndex < items.length) {
            const idx = nextIndex++
            results[idx] = await fn(items[idx], idx)
        }
    })

    await Promise.all(workers)
    return results
}

/**
 * Computes deterministic SHA-256 hash of extracted text for idempotency check.
 */
async function computeTextHash(text: string): Promise<string> {
    if (!text) return ""
    try {
        const encoded = new TextEncoder().encode(text)
        const hashBuf = await crypto.subtle.digest("SHA-256", encoded)
        const hashArray = Array.from(new Uint8Array(hashBuf))
        return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("")
    } catch {
        let h = 0x811c9dc5
        for (let i = 0; i < text.length; i++) {
            h = (h ^ text.charCodeAt(i)) * 0x01000193
        }
        return (h >>> 0).toString(16)
    }
}

/**
 * Perform vision OCR using Workers AI model.
 */
export async function performVisionOcr(
    ai: WorkersAi,
    pngBytes: Uint8Array,
    _pageNumber: number
): Promise<string> {
    if (!ai || typeof ai.run !== "function") {
        throw new Error("Workers AI binding (AI) is missing or unavailable for OCR.")
    }

    const prompt =
        "Transcribe all visible text, numbers, labels, and tables in this document image verbatim in natural reading order. Return only the extracted text without commentary."

    const imageArray = Array.from(pngBytes)

    let response: unknown
    try {
        response = await ai.run(VISION_OCR_MODEL_ID, {
            image: imageArray,
            prompt,
            max_tokens: 2048,
        })
    } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err)
        if (
            errMsg.includes("5016") ||
            errMsg.includes("submit the prompt 'agree'") ||
            errMsg.includes("Community License")
        ) {
            try {
                await ai.run(VISION_OCR_MODEL_ID, { prompt: "agree" })
            } catch {}
            response = await ai.run(VISION_OCR_MODEL_ID, {
                image: imageArray,
                prompt,
                max_tokens: 2048,
            })
        } else {
            try {
                response = await ai.run(VISION_OCR_MODEL_ID, {
                    image: imageArray,
                    messages: [{ role: "user", content: prompt }],
                    max_tokens: 2048,
                })
            } catch {
                throw err
            }
        }
    }

    let text = ""
    if (typeof response === "string") {
        text = response
    } else if (response && typeof response === "object") {
        const resObj = response as { response?: string; description?: string; text?: string }
        text = resObj.response || resObj.description || resObj.text || ""
    }

    return text
        .split("\0")
        .join("")
        .replace(/\r\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim()
}

/**
 * Primary PDF Document Extractor.
 * Extracts embedded text using unpdf and conditionally executes vision OCR
 * on pages where usable embedded text is absent or incomplete.
 */
export async function extractPdfDocument(
    pdfBuffer: ArrayBuffer | Uint8Array,
    options: PdfExtractionOptions = {}
): Promise<ExtractedDocumentResult> {
    const uint8 = pdfBuffer instanceof Uint8Array ? pdfBuffer : new Uint8Array(pdfBuffer)
    if (uint8.byteLength < 5) {
        return {
            pages: [],
            totalPages: 0,
            extractionMode: "text",
            ocrPagesCount: 0,
            contentHash: "",
        }
    }

    const maxOcrPages = options.maxOcrPages ?? 10
    const ocrConcurrency = options.ocrConcurrency ?? 2
    const enableOcr = options.enableOcr !== false
    const ai = options.ai as WorkersAi | undefined

    let pdf: Awaited<ReturnType<typeof getDocumentProxy>> | undefined
    let rawPageTexts: string[] = []
    let totalPages = 0

    // Step 1: unpdf extraction with proxy
    try {
        pdf = await getDocumentProxy(uint8)
        const extracted = await extractText(pdf, { mergePages: false })
        rawPageTexts = Array.isArray(extracted.text) ? extracted.text : [extracted.text || ""]
        totalPages = extracted.totalPages || pdf.numPages || rawPageTexts.length
    } catch (unpdfErr) {
        console.warn("unpdf text extraction error:", unpdfErr)
        // Fallback: Workers AI toMarkdown if binding provides document conversion
        if (ai && typeof ai.toMarkdown === "function") {
            try {
                const res = await ai.toMarkdown(uint8.buffer as ArrayBuffer, {
                    conversionOptions: { output: { format: "text" } },
                })
                const parsed = res?.content || res?.text || ""
                if (parsed.trim().length > 0) {
                    const pages = [{ pageNumber: 1, text: parsed.trim() }]
                    return {
                        pages,
                        totalPages: 1,
                        extractionMode: "text",
                        ocrPagesCount: 0,
                        contentHash: await computeTextHash(parsed.trim()),
                    }
                }
            } catch (aiErr) {
                console.warn("Workers AI toMarkdown fallback error:", aiErr)
            }
        }
        return {
            pages: [],
            totalPages: 0,
            extractionMode: "text",
            ocrPagesCount: 0,
            contentHash: "",
        }
    }

    // Step 2: Evaluate usability per page
    interface PageAnalysis {
        pageNumber: number
        embeddedText: string
        quality: PageQualityAssessment
        needsOcr: boolean
        finalText: string
        ocrAttempted: boolean
        ocrSuccess: boolean
    }

    const pagesAnalysis: PageAnalysis[] = []
    for (let i = 0; i < totalPages; i++) {
        const pageNumber = i + 1
        const raw = rawPageTexts[i] || ""
        const cleaned = raw
            .split("\0")
            .join("")
            .replace(/\r\n/g, "\n")
            .replace(/\n{3,}/g, "\n\n")
            .trim()

        const quality = evaluatePageTextQuality(cleaned)
        const needsOcr = !quality.isUsable

        pagesAnalysis.push({
            pageNumber,
            embeddedText: cleaned,
            quality,
            needsOcr,
            finalText: cleaned,
            ocrAttempted: false,
            ocrSuccess: false,
        })
    }

    // Step 3: Conditional OCR on candidate pages
    const ocrCandidatePages = pagesAnalysis.filter((p) => p.needsOcr)
    let ocrPagesCount = 0

    if (enableOcr && ai && ocrCandidatePages.length > 0) {
        // Enforce maximum OCR page budget
        const pagesToOcr = ocrCandidatePages.slice(0, maxOcrPages)
        // Maintain image deduplication map across pages to skip repeated logos and watermarks
        const seenImageMap = new Map<string, { count: number; ocrResult?: string }>()

        await runWithConcurrency(pagesToOcr, ocrConcurrency, async (pageAnalysis) => {
            pageAnalysis.ocrAttempted = true
            try {
                // Extract images from this specific page reusing the active pdf proxy
                const images = await extractImages(pdf, pageAnalysis.pageNumber).catch((err) => {
                    console.warn(
                        `[PDF OCR] Failed to extract images for page ${pageAnalysis.pageNumber}:`,
                        err
                    )
                    return []
                })

                if (!images || images.length === 0) {
                    return
                }

                // Filter candidate document images (reject tiny icons, decorative dividers, extreme aspect ratios)
                const candidates = images.filter((img) => isCandidateOcrImage(img))
                if (candidates.length === 0) {
                    return
                }

                // Sort candidate images by area descending (largest first) and limit to top 3
                candidates.sort((a, b) => b.width * b.height - a.width * a.height)
                const topCandidates = candidates.slice(0, 3)

                const pageOcrResults: string[] = []

                for (const img of topCandidates) {
                    const imgHash = computeImageHash(img.width, img.height, img.channels, img.data)
                    const seen = seenImageMap.get(imgHash)

                    if (seen) {
                        seen.count++
                        // If this image was already seen on another page (e.g. repeated header logo / watermark):
                        // If it produced meaningful text, avoid re-calling OCR
                        if (seen.ocrResult && seen.ocrResult.length > 15) {
                            pageOcrResults.push(seen.ocrResult)
                        }
                        continue
                    }

                    // First time seeing this image
                    seenImageMap.set(imgHash, { count: 1 })

                    try {
                        const pngBytes = await encodeRawToPng(
                            img.width,
                            img.height,
                            img.channels,
                            img.data
                        )
                        const ocrResult = await performVisionOcr(
                            ai,
                            pngBytes,
                            pageAnalysis.pageNumber
                        )
                        if (ocrResult && ocrResult.length > 0) {
                            seenImageMap.get(imgHash)!.ocrResult = ocrResult
                            pageOcrResults.push(ocrResult)
                        }
                    } catch (singleImgErr) {
                        console.warn(
                            `[PDF OCR] Vision inference error on page ${pageAnalysis.pageNumber} image ${imgHash}:`,
                            singleImgErr
                        )
                    }
                }

                if (pageOcrResults.length > 0) {
                    const combinedOcrText = pageOcrResults.join("\n\n")
                    // Merge embedded text and OCR text with strict deduplication
                    pageAnalysis.finalText = mergePageText(
                        pageAnalysis.embeddedText,
                        combinedOcrText
                    )
                    pageAnalysis.ocrSuccess = true
                    ocrPagesCount++
                }
            } catch (pageOcrErr) {
                // Per-page error isolation: if page OCR fails, keep embedded text and continue
                console.warn(
                    `[PDF OCR] Error during OCR processing for page ${pageAnalysis.pageNumber}:`,
                    pageOcrErr
                )
            }
        })
    }

    // Free PDF.js resources
    try {
        if (pdf && pdf.loadingTask && typeof pdf.loadingTask.destroy === "function") {
            await pdf.loadingTask.destroy()
        }
    } catch {}

    // Step 4: Assemble valid extracted pages
    const finalPages: PdfPageContent[] = []
    for (const pa of pagesAnalysis) {
        const text = pa.finalText.trim()
        if (text.length > 0) {
            finalPages.push({
                pageNumber: pa.pageNumber,
                text,
            })
        }
    }

    // Step 5: Determine extraction mode
    let extractionMode: "text" | "ocr" | "mixed" = "text"
    if (ocrPagesCount > 0) {
        if (
            ocrPagesCount === finalPages.length &&
            pagesAnalysis.every((p) => !p.quality.isUsable)
        ) {
            extractionMode = "ocr"
        } else {
            extractionMode = "mixed"
        }
    }

    const allText = finalPages.map((p) => p.text).join("\n\n")
    const contentHash = await computeTextHash(allText)

    return {
        pages: finalPages,
        totalPages,
        extractionMode,
        ocrPagesCount,
        contentHash,
        details: {
            ocrAttemptedPages: pagesAnalysis.filter((p) => p.ocrAttempted).length,
            ocrSuccessfulPages: ocrPagesCount,
            ocrFailedPages: pagesAnalysis.filter((p) => p.ocrAttempted && !p.ocrSuccess).length,
            skippedOcrPages: pagesAnalysis.filter((p) => !p.needsOcr).length,
        },
    }
}

/**
 * Extract selectable plain text by page from a PDF document buffer.
 * Returns an array of pages with 1-indexed pageNumber and cleaned text.
 */
export async function extractPdfPages(
    pdfBuffer: ArrayBuffer | Uint8Array,
    aiBinding?: unknown,
    options?: Partial<PdfExtractionOptions>
): Promise<PdfPageContent[]> {
    const result = await extractPdfDocument(pdfBuffer, {
        ai: aiBinding,
        enableOcr: Boolean(aiBinding),
        ...options,
    })
    return result.pages
}

/**
 * Extract selectable plain text from a PDF document buffer.
 * Powered by unpdf with conditional OCR for image-based pages.
 */
export async function extractPdfText(
    pdfBuffer: ArrayBuffer | Uint8Array,
    aiBinding?: unknown,
    options?: Partial<PdfExtractionOptions>
): Promise<string> {
    const pages = await extractPdfPages(pdfBuffer, aiBinding, options)
    return pages.map((p) => p.text).join("\n\n")
}
