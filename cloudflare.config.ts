import { bindings, defineConfig, defineWorker, exports } from "cf/config"

export default defineConfig({
    accountId: "84b09cdd14a077b27e00b990e8ac417f",
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
                id: "81e1eee3-ec8f-4868-8dab-caa4077b3013",
            }),
            // R2 bucket for file storage
            FILES: bindings.r2({
                name: "chatbot-files",
            }),
            // Vectorize index for RAG (768 dimensions, cosine metric)
            VECTORIZE: bindings.vectorize({
                name: "chatbot-rag-index",
            }),
            // Cloudflare Workflow binding
            PDF_WORKFLOW: bindings.workflow({
                name: "pdf-processing-workflow",
                worker: "cf-ai",
                exportName: "PdfProcessingWorkflow",
            }),
            // Durable Object binding for SSE progress
            DOCUMENT_PROGRESS_DO: bindings.durableObject({
                worker: "cf-ai",
                exportName: "DocumentProgressDO",
            }),
            // Application security PIN secret binding
            APP_PIN: bindings.secret(),
        },
    }),
})
