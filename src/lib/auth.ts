// Application authentication configuration
// 4-digit PIN for access control retrieved from Cloudflare Worker request context/env
import { env as workersEnv } from "cloudflare:workers";

import { AUTH_HEADER_NAME } from "./auth-client";
export * from "./auth-client";

/**
 * Extract Cloudflare environment bindings from Request, Context, or ambient workers runtime.
 * Never relies on process.env in production Cloudflare runtime.
 */
export function getRequestContextEnv(reqOrContext?: any): Cloudflare.Env | Record<string, any> | undefined {
  if (reqOrContext) {
    // 1. Direct env on request (e.g. req.env)
    if (reqOrContext.env && typeof reqOrContext.env === "object") {
      return reqOrContext.env;
    }
    // 2. Context env (e.g. context.env or req.context.env)
    if (reqOrContext.context?.env && typeof reqOrContext.context.env === "object") {
      return reqOrContext.context.env;
    }
    // 3. Cloudflare context bridge (e.g. req.cloudflare?.env)
    if (reqOrContext.cloudflare?.env && typeof reqOrContext.cloudflare.env === "object") {
      return reqOrContext.cloudflare.env;
    }
  }

  // 4. Global workers ambient env from "cloudflare:workers"
  if (typeof workersEnv !== "undefined" && workersEnv) {
    return workersEnv;
  }

  return undefined;
}

/**
 * Get configured APP_PIN from request/context environment without using hardcoded fallbacks.
 */
export function getAppPin(reqOrContext?: any): string | undefined {
  const envObj = getRequestContextEnv(reqOrContext);
  const pin = (envObj as any)?.APP_PIN;
  if (typeof pin === "string" && pin.trim().length > 0) {
    return pin.trim();
  }
  return undefined;
}

// Backward compatibility export (falls back to workersEnv)
export const APP_PIN: string | undefined =
  typeof workersEnv !== "undefined" && (workersEnv as any)?.APP_PIN
    ? (workersEnv as any).APP_PIN
    : undefined;

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
  reqOrContext?: any
): boolean {
  let pin: string | null | undefined;
  let context: any;

  if (pinOrReq && typeof pinOrReq === "object" && "headers" in pinOrReq) {
    // Called with Request object directly: verifyPin(req)
    pin = (pinOrReq as Request).headers.get(AUTH_HEADER_NAME);
    context = pinOrReq;
  } else {
    pin = pinOrReq as string | null | undefined;
    context = reqOrContext;
  }

  if (!pin) return false;

  const expectedPin = getAppPin(context);
  if (!expectedPin) {
    console.error("[Auth] Access denied: APP_PIN is not configured in Cloudflare environment secrets.");
    return false;
  }
  return pin.trim() === expectedPin;
}

