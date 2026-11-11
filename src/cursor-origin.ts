import { type ForgeCredential, type ForgeOptions, resolveForge } from "./core/forge.ts";
import { listForge } from "./core/forge-list.ts";
import { isOriginInstance } from "./core/origin.ts";
import type { CredentialInfo, ListOptions } from "./core/types.ts";

export type { ForgeCredential, ForgeOptions } from "./core/forge.ts";

/**
 * Find a Cursor Origin token: explicit, CURSOR_AUTH_TOKEN, `origin auth token`, saved login.
 * @param options - Explicit token, and a `baseURL` on api.cursor.com or origin.cursor.com.
 * @returns {ForgeCredential | null} The token and its source, or null.
 */
export function resolve(options?: ForgeOptions): ForgeCredential | null {
  const baseURL = options?.baseURL;
  if (baseURL === undefined || !isOriginInstance(baseURL)) {
    return resolveForge("cursor-origin", options);
  }
  return resolveForge("cursor-origin", { ...options, baseURL: undefined });
}

/**
 * Describe CURSOR_AUTH_TOKEN, CURSOR_API_KEY and origin's saved login, without the tokens.
 * @param options - Whether to ask Origin about each token.
 * @returns {Promise<CredentialInfo[]>} The variable first, then what `origin` would use.
 */
export function list(options?: ListOptions): Promise<CredentialInfo[]> {
  return listForge("cursor-origin", options);
}
