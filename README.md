# Claude-Style Cloudflare AI Chat Web App

A full-stack, Claude-style chat web application running on **Next.js (App Router)** via the **vinext** runtime adapter, powered **exclusively by Cloudflare products**:

- **Workers AI**: Edge LLM streaming inference, deep reasoning models, vision analysis, text embeddings, and audio transcription.
- **D1 Database**: Serverless relational SQLite database storing multi-turn chat history, conversations, and document records.
- **R2 Storage**: Zero-egress object storage for user uploads, reference files, and multimodal images.
- **Vectorize**: High-performance vector database powering semantic search and Retrieval-Augmented Generation (RAG).

---

## 1. Placeholders to Replace

Before deploying or running with remote bindings, replace the placeholders in **`cloudflare.config.ts`** and **`wrangler.jsonc`**:

| Resource            | Name / ID                                             | Binding     | Status                                                  |
| ------------------- | ----------------------------------------------------- | ----------- | ------------------------------------------------------- |
| **Account ID**      | `7ab77eaa396c9a6435e5659a299e07cf`                    | —           | Configured in `wrangler.jsonc` & `cloudflare.config.ts` |
| **D1 Database**     | `chatbot-db` (`23e4591c-4d67-4851-8e50-772a7b1fc6be`) | `DB`        | Created & Migrations Executed                           |
| **R2 Bucket**       | `chatbot-files`                                       | `FILES`     | Created                                                 |
| **Vectorize Index** | `chatbot-rag-index` (768 dim, cosine)                 | `VECTORIZE` | Created                                                 |
| **Workers AI**      | Multi-model catalog                                   | `AI`        | Ready                                                   |

---

## 2. Resource Creation Commands (Run manually)

Execute the following commands to provision your Cloudflare resources:

### 1. Create D1 Database

```bash
npx wrangler d1 create chatbot-db
```

_Note the returned `database_id` UUID and replace `REPLACE_WITH_D1_ID` in `cloudflare.config.ts` and `wrangler.jsonc`._

### 2. Create R2 Bucket

```bash
npx wrangler r2 bucket create chatbot-files
```

_Replace `REPLACE_WITH_R2_BUCKET_NAME` in `cloudflare.config.ts` and `wrangler.jsonc` with `chatbot-files` (or your chosen name)._

### 3. Create Vectorize Index (768 dimensions, cosine metric)

```bash
npx wrangler vectorize create chatbot-rag-index --dimensions=768 --metric=cosine
```

_The 768 dimensions and cosine distance metric directly match the `@cf/baai/bge-base-en-v1.5` Workers AI embedding model._

---

## 3. Applying D1 Database Migrations

Apply the initial database schema to create the `conversations`, `messages`, and `documents` tables:

### Apply locally:

```bash
npx wrangler d1 migrations apply chatbot-db --local
# or execute directly from schema.sql:
npx wrangler d1 execute chatbot-db --local --file=./schema.sql
```

### Apply to remote Cloudflare D1:

```bash
npx wrangler d1 migrations apply chatbot-db --remote
# or execute directly from schema.sql:
npx wrangler d1 execute chatbot-db --remote --file=./schema.sql
```

---

## 4. Local Development & Running

### Install dependencies:

```bash
npm install
```

### Regenerate Cloudflare Types (whenever `cloudflare.config.ts` changes):

```bash
npm run cf-typegen
```

### Run local dev server:

```bash
npm run dev
```

Open [http://localhost:3001](http://localhost:3001) in your browser.

### Build and preview locally:

```bash
npm run build
npm run start
```

---

## 5. Deployment

Deploy the application directly to Cloudflare Workers using the vinext Cloudflare adapter:

```bash
npm run deploy
```

or:

```bash
npx @vinext/cloudflare deploy
```

---

## 6. Model Catalog & Capabilities

The application features a data-driven model catalog (`src/lib/models.ts`) verified against Cloudflare Workers AI:

| Category                   | Model                       | ID                                             | Features                                                        |
| -------------------------- | --------------------------- | ---------------------------------------------- | --------------------------------------------------------------- |
| **Fast / Small (Default)** | Llama 3.1 8B Instruct       | `@cf/meta/llama-3.1-8b-instruct`               | 128k context, ultra-fast low-latency responses                  |
| **General**                | Llama 3.3 70B Instruct Fast | `@cf/meta/llama-3.3-70b-instruct-fp8-fast`     | 128k context, FP8 quantized high performance                    |
| **General**                | Gemma 7B IT                 | `@cf/google/gemma-7b-it`                       | 8k context, Google open weights                                 |
| **Reasoning**              | DeepSeek R1 Distill 32B     | `@cf/deepseek-ai/deepseek-r1-distill-qwen-32b` | Emits `<think>` reasoning traces, separated into collapsible UI |
| **Reasoning**              | QwQ 32B Preview             | `@cf/qwen/qwq-32b`                             | Alibaba step-by-step thinking & math model                      |
| **Reasoning**              | GPT-OSS 20B                 | `@cf/openai/gpt-oss-20b`                       | OpenAI open-weights reasoning model                             |
| **Coding**                 | Qwen 2.5 Coder 32B          | `@cf/qwen/qwen2.5-coder-32b-instruct`          | State-of-the-art coding, debugging, and refactoring             |
| **Vision**                 | Llama 3.2 11B Vision        | `@cf/meta/llama-3.2-11b-vision-instruct`       | Multimodal high-resolution image analysis                       |
| **Embeddings**             | BGE Base EN v1.5            | `@cf/baai/bge-base-en-v1.5`                    | 768-dim dense vectors for Vectorize RAG                         |
| **Voice Transcription**    | Whisper                     | `@cf/openai/whisper`                           | Multilingual speech-to-text fallback                            |

---

## 7. Frontend Features (Claude Design System)

- **Claude Aesthetic**: Warm cream and sand neutrals in light mode (`#FAF9F5`), rich charcoal in dark mode (`#181716`), elegant terracotta accents (`#C2410C`), and serif-inspired typography.
- **Collapsible Sidebar**: Grouped conversation history (**Today**, **Yesterday**, **Previous 7 days**, **Older**), live search, inline conversation renaming, and deletion. Collapses to a smooth drawer on mobile viewports.
- **Streaming Response**: Real-time Server-Sent Events (SSE) streaming with auto-scroll that smartly pauses when the user scrolls up.
- **Collapsible Thought Process**: Separates `<think>...</think>` tags from reasoning models (e.g. DeepSeek R1) into an expandable thought tray.
- **Syntax-Highlighted Markdown**: Code blocks with language tags, copy buttons with visual feedback, formatted tables, lists, and blockquotes.
- **Multimodal Composer**:
    - Model dropdown with search, capability badges, and category filter chips.
    - Context mode selector: **Conversation** (history), **Knowledge base** (Vectorize RAG), **Attached files**, or **None** (isolated single prompt).
    - Effort selector: **Low** (concise), **Medium** (balanced), **High** (deep step-by-step thinking).
    - Voice typing via native Web Speech API with MediaRecorder + Whisper fallback.
    - Multi-file attachment preview chips with upload progress.
- **Knowledge Base Modal**: View, upload, and delete indexed reference files in R2 and Vectorize.
- **Resilience**: Non-mock production paths with clean error states and toast notifications when Cloudflare bindings are missing or misconfigured.

---

## 8. Known Limitations & Notes

- **Workers AI Rate Limits**: Free tier accounts may encounter concurrency or rate limits on large models like `llama-3.3-70b`. The app gracefully surfaces these errors via the toast system.
- **Vision Model Image Acceptance**: Meta requires a one-time agreement on `@cf/meta/llama-3.2-11b-vision-instruct` if invoking via the Cloudflare dashboard API for the first time.
- **Local Dev workerd Bindings**: When running `npm run dev`, Vite runs the RSC environment in `workerd`. To query remote D1 databases or Vectorize indexes during local dev, ensure you pass `--remote` to wrangler or run migrations locally.
