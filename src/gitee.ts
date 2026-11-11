import { type ForgeCredential, type ForgeOptions, resolveForge } from "./core/forge.ts";
import { listForge } from "./core/forge-list.ts";
import type { CredentialInfo, ListOptions } from "./core/types.ts";

export type { ForgeCredential, ForgeOptions } from "./core/forge.ts";

/**
 * Find a gitee.com token: the explicit one, then GITEE_TOKEN, then GITEE_ACCESS_TOKEN.
 * @param options - Explicit token; `baseURL` and `account` change nothing for Gitee.
 * @returns {ForgeCredential | null} The token and its source, or null when no variable is set.
 */
export function resolve(options?: ForgeOptions): ForgeCredential | null {
  return resolveForge("gitee", options);
}

/**
 * Describe every Gitee token variable, without the tokens. `verify` asks the API at
 * GITEE_API_BASE, gitee.com by default.
 * @param options - Whether to ask the forge.
 * @returns {Promise<CredentialInfo[]>} One entry per set variable.
 */
export function list(options?: ListOptions): Promise<CredentialInfo[]> {
  return listForge("gitee", options);
}
