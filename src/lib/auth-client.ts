export const AUTH_STORAGE_KEY = "cf_ai_app_pin"
export const AUTH_HEADER_NAME = "x-app-pin"

/**
 * Helper to get authorization headers for client fetch calls
 */
export function getAuthHeaders(
    existingHeaders: Record<string, string> = {}
): Record<string, string> {
    const headers: Record<string, string> = { ...existingHeaders }
    if (typeof window !== "undefined") {
        const pin = localStorage.getItem(AUTH_STORAGE_KEY)
        if (pin) {
            headers[AUTH_HEADER_NAME] = pin
        }
    }
    return headers
}
