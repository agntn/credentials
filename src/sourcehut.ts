import { type ForgeCredential, type ForgeOptions, resolveForge } from "./core/forge.ts";
import { listForge } from "./core/forge-list.ts";
import type { CredentialInfo, ListOptions } from "./core/types.ts";

export type { ForgeCredential, ForgeOptions } from "./core/forge.ts";

/**
 * Find a Sourcehut token: the explicit one, then SRHT_TOKEN, then hut's config file, since hut prints no token.
 * @param options - Explicit token, instance URL (`https://git.sr.ht` finds the `sr.ht` instance) and account.
 * @returns {ForgeCredential | null} The token and its source, or null when nothing holds one.
 */
export function resolve(options?: ForgeOptions): ForgeCredential | null {
  return resolveForge("sourcehut", options);
}

/**
 * Describe every Sourcehut credential this machine holds, without the tokens: SRHT_TOKEN,
 * then each hut instance. `verify` asks each instance's meta.sr.ht who the token belongs to.
 * @param options - Whether to ask the forge.
 * @returns {Promise<CredentialInfo[]>} One entry per credential.
 */
export function list(options?: ListOptions): Promise<CredentialInfo[]> {
  return listForge("sourcehut", options);
}
