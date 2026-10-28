import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execSync, spawn } from "node:child_process"

// If CLOUDFLARE_API_TOKEN is not explicitly provided, ensure Wrangler refreshes its token and read it
if (!process.env.CLOUDFLARE_API_TOKEN) {
    try {
        const configPath = path.join(os.homedir(), ".wrangler", "config", "default.toml")
        if (fs.existsSync(configPath)) {
            // Auto-refresh token with wrangler whoami if needed
            try {
                execSync("npx wrangler whoami", { stdio: "ignore" })
            } catch {}

            const content = fs.readFileSync(configPath, "utf-8")
            const match = content.match(/oauth_token\s*=\s*"([^"]+)"/)
            if (match && match[1]) {
                process.env.CLOUDFLARE_API_TOKEN = match[1]
            }
        }
    } catch {
        // Ignore and let cf check other auth sources
    }
}

// Pass Account ID if not set
if (!process.env.CLOUDFLARE_ACCOUNT_ID) {
    process.env.CLOUDFLARE_ACCOUNT_ID = "84b09cdd14a077b27e00b990e8ac417f"
}

const child = spawn("vinext-cloudflare", ["deploy", ...process.argv.slice(2)], {
    stdio: "inherit",
    env: process.env,
    shell: true,
})

child.on("exit", (code) => {
    process.exit(code ?? 0)
})
