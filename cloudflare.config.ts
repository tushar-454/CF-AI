import { bindings, defineConfig, defineWorker, exports } from "cf/config"

export default defineConfig({
    accountId: "7ab77eaa396c9a6435e5659a299e07cf",
    worker: defineWorker({
        name: "cf-ai",
        entrypoint: "./worker/index.ts",
        compatibilityDate: "2026-10-27",
        compatibilityFlags: ["nodejs_compat"],
        assets: {
            htmlHandling: "none",
            notFoundHandling: "none",
            runWorkerFirst: ["/*", "!/_next/static/*", "!/*/_next/static/*"],
        },
        exports: {
            PdfProcessingWorkflow: exports.workflow({ name: "pdf-processing-workflow" }),
            YoutubeProcessingWorkflow: exports.workflow({ name: "youtube-processing-workflow" }),
            DocumentProgressDO: exports.durableObject({ storage: "sqlite" }),
        },
        env: {
            ASSETS: bindings.assets(),
            IMAGES: bindings.images(),
            // Workers AI binding
            AI: bindings.ai(),
            // D1 database binding
            DB: bindings.d1({
                name: "chatbot-db",
                id: "52285e7e-0124-4a60-a144-03dc406a11fe",
            }),
            // R2 bucket for file storage
            FILES: bindings.r2({
                name: "chatbot-files",
            }),
            // Vectorize index for RAG (768 dimensions, cosine metric)
            VECTORIZE: bindings.vectorize({
                name: "chatbot-rag-index",
            }),
            // Cloudflare Workflow bindings
            PDF_WORKFLOW: bindings.workflow({
                name: "pdf-processing-workflow",
                worker: "cf-ai",
                exportName: "PdfProcessingWorkflow",
            }),
            YOUTUBE_WORKFLOW: bindings.workflow({
                name: "youtube-processing-workflow",
                worker: "cf-ai",
                exportName: "YoutubeProcessingWorkflow",
            }),
            // Durable Object binding for SSE progress
            DOCUMENT_PROGRESS_DO: bindings.durableObject({
                worker: "cf-ai",
                exportName: "DocumentProgressDO",
            }),
            // Application security PIN secret binding
            APP_PIN: bindings.secret(),
            // Supadata API secret binding (kept for compatibility)
            SUPADATA_API_KEY: bindings.secret(),
            // ScrapingBee API secret binding for YouTube transcript extraction
            SCRAPINGBEE_API_KEY: bindings.secret(),
        },
    }),
})
