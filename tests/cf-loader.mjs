import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const rootDir = process.cwd()

export function resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") {
        return {
            format: "module",
            shortCircuit: true,
            url:
                "data:text/javascript," +
                encodeURIComponent(`
                export const env = {};
                export class DurableObject {
                    constructor(ctx, env) {
                        this.ctx = ctx;
                        this.env = env;
                    }
                }
                export class WorkflowEntrypoint {
                    constructor(ctx, env) {
                        this.ctx = ctx;
                        this.env = env;
                    }
                }
            `),
        }
    }

    let candidatePath = null

    if (specifier.startsWith("@/")) {
        candidatePath = path.join(rootDir, "src", specifier.slice(2))
    } else if (specifier.startsWith("./") || specifier.startsWith("../")) {
        if (context.parentURL && context.parentURL.startsWith("file://")) {
            const parentDir = path.dirname(fileURLToPath(context.parentURL))
            candidatePath = path.resolve(parentDir, specifier)
        }
    }

    if (candidatePath) {
        const extensions = [
            "",
            ".ts",
            ".tsx",
            ".js",
            ".mjs",
            "/index.ts",
            "/index.tsx",
            "/index.js",
        ]
        for (const ext of extensions) {
            const probe = candidatePath + ext
            if (fs.existsSync(probe) && fs.statSync(probe).isFile()) {
                return nextResolve(pathToFileURL(probe).href, context)
            }
        }
    }

    return nextResolve(specifier, context)
}
