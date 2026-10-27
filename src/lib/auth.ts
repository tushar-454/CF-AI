// Application authentication configuration
// 4-digit PIN for access control (configured via APP_PIN in .env, defaults to "9999")
export const APP_PIN =
  (typeof process !== "undefined" && process.env?.APP_PIN) ? process.env.APP_PIN : "0000";
export const AUTH_STORAGE_KEY = "cf_ai_app_pin";
export const AUTH_HEADER_NAME = "x-app-pin";

/**
 * Verify if the provided PIN matches the hardcoded application PIN
 */
export function verifyPin(pin: string | null | undefined): boolean {
  if (!pin) return false;
  return pin.trim() === APP_PIN;
}

/**
 * Helper to get authorization headers for client fetch calls
 */
export function getAuthHeaders(existingHeaders: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = { ...existingHeaders };
  if (typeof window !== "undefined") {
    const pin = localStorage.getItem(AUTH_STORAGE_KEY);
    if (pin) {
      headers[AUTH_HEADER_NAME] = pin;
    }
  }
  return headers;
}
