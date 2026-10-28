// Application authentication configuration
// 4-digit PIN for access control retrieved from Cloudflare Worker request context/env
import { env as workersEnv } from "cloudflare:workers"
import type { AppEnv } from "./types"
import { AUTH_HEADER_NAME } from "./auth-client"
export * from "./auth-client"

interface RequestOrContextWithEnv {
    env?: Record<string, unknown>
    context?: { env?: Record<string, unknown> }
    cloudflare?: { env?: Record<string, unknown> }
}

/**
 * Extract Cloudflare environment bindings from Request, Context, or ambient workers runtime.
 * Never relies on process.env in production Cloudflare runtime.
 */
export function getRequestContextEnv(reqOrContext?: unknown): Record<string, unknown> | undefined {
    if (reqOrContext && typeof reqOrContext === "object") {
        const obj = reqOrContext as RequestOrContextWithEnv
        // 1. Direct env on request (e.g. req.env)
        if (obj.env && typeof obj.env === "object") {
            return obj.env
        }
        // 2. Context env (e.g. context.env or req.context.env)
        if (obj.context?.env && typeof obj.context.env === "object") {
            return obj.context.env
        }
        // 3. Cloudflare context bridge (e.g. req.cloudflare?.env)
        if (obj.cloudflare?.env && typeof obj.cloudflare.env === "object") {
            return obj.cloudflare.env
        }
    }

    // 4. Global workers ambient env from "cloudflare:workers"
    if (typeof workersEnv !== "undefined" && workersEnv) {
        return workersEnv as unknown as Record<string, unknown>
    }

    return undefined
}

/**
 * Get configured APP_PIN from request/context environment without using hardcoded fallbacks.
 */
export function getAppPin(reqOrContext?: unknown): string | undefined {
    const envObj = getRequestContextEnv(reqOrContext)
    const pin = (envObj as AppEnv | undefined)?.APP_PIN
    if (typeof pin === "string" && pin.trim().length > 0) {
        return pin.trim()
    }
    return undefined
}

// Backward compatibility export (falls back to workersEnv)
export const APP_PIN: string | undefined =
    typeof workersEnv !== "undefined" && (workersEnv as unknown as AppEnv)?.APP_PIN
        ? (workersEnv as unknown as AppEnv).APP_PIN
        : undefined

/**
 * Verify if the provided PIN matches the application PIN from request/context env.
 * Does not use process.env.
 * Can be called as:
 * - verifyPin(pin, req)
 * - verifyPin(req)
 * - verifyPin(pin)
 */
export function verifyPin(
    pinOrReq: string | null | undefined | Request,
    reqOrContext?: unknown
): boolean {
    let pin: string | null | undefined
    let context: unknown

    if (pinOrReq && typeof pinOrReq === "object" && "headers" in pinOrReq) {
        // Called with Request object directly: verifyPin(req)
        pin = (pinOrReq as Request).headers.get(AUTH_HEADER_NAME)
        context = pinOrReq
    } else {
        pin = pinOrReq as string | null | undefined
        context = reqOrContext
    }

    if (!pin) return false

    const expectedPin = getAppPin(context)
    if (!expectedPin) {
        console.error(
            "[Auth] Access denied: APP_PIN is not configured in Cloudflare environment secrets."
        )
        return false
    }
    return pin.trim() === expectedPin
}
