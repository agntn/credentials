import { CAFE_API, cafeApiUrl, cafeCliToken, cafeLoginFor, cafeSavedToken } from "./core/cafe.ts";
import {
  CONFIG_FILES,
  type ForgeCredential,
  type ForgeOptions,
  resolveForge,
  savedCredential,
} from "./core/forge.ts";
import { listForge } from "./core/forge-list.ts";
import type { CredentialInfo, ListOptions } from "./core/types.ts";

export type { ForgeCredential, ForgeOptions } from "./core/forge.ts";

/**
 * Find a GitCafe token: explicit, CAFE_TOKEN, `cafe`'s login helper, then its plaintext file.
 * @param options - Explicit token, and `baseURL` of the instance, git.cafe by default.
 * @returns {ForgeCredential | null} The token and its source, or null.
 */
export function resolve(options?: ForgeOptions): ForgeCredential | null {
  return resolveForge("gitcafe", options) ?? fromCafe(options);
}

/**
 * Read `cafe`'s login for the instance the caller targets, the way `cafe` itself would.
 * @param options - The caller's account and `baseURL`.
 * @returns {ForgeCredential | null} The token, or null.
 */
function fromCafe(options: ForgeOptions | undefined): ForgeCredential | null {
  if (options?.account !== undefined) return null;
  const apiUrl = options?.baseURL ? cafeApiUrl(options.baseURL) : CAFE_API;
  if (apiUrl === undefined) return null;
  const fromCli = cafeCliToken(apiUrl);
  if (fromCli !== null) return { token: fromCli, source: "cli", origin: "cafe" };
  return savedCredential(liveSavedToken(apiUrl), CONFIG_FILES.gitcafe);
}

/**
 * Read the plaintext token `cafe` would still send.
 * @param apiUrl - The API base the caller targets.
 * @returns {string | null} The token, or null when there is none or it has expired.
 */
function liveSavedToken(apiUrl: string): string | null {
  const login = cafeLoginFor(apiUrl);
  const saved = login === undefined ? undefined : cafeSavedToken(login);
  if (saved === undefined) return null;
  return saved.expiresAt === undefined || saved.expiresAt > Date.now() ? saved.token : null;
}

/**
 * Describe CAFE_TOKEN and `cafe`'s saved logins, without the tokens.
 * @param options - Whether to ask each instance.
 * @returns {Promise<CredentialInfo[]>} The variable first, then `cafe.json` in file order.
 */
export function list(options?: ListOptions): Promise<CredentialInfo[]> {
  return listForge("gitcafe", options);
}
