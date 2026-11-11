import { type ForgeCredential, type ForgeOptions, resolveForge } from "./core/forge.ts";
import { listForge } from "./core/forge-list.ts";
import type { CredentialInfo, ListOptions } from "./core/types.ts";

export type { ForgeCredential, ForgeOptions } from "./core/forge.ts";

/**
 * Find a Bitbucket Cloud token: the explicit one, then BITBUCKET_TOKEN as a bearer, then
 * BITBUCKET_API_TOKEN with BITBUCKET_EMAIL as its basic auth login.
 * @param options - Explicit token and its `username`; `baseURL` and `account` change nothing here.
 * @returns {ForgeCredential | null} The token, its source and any login, or null when nothing fits.
 */
export function resolve(options?: ForgeOptions): ForgeCredential | null {
  return resolveForge("bitbucket", options);
}

/**
 * Describe every Bitbucket token variable, without the tokens. `verify` asks api.bitbucket.org
 * about the API token; access tokens can't be checked there.
 * @param options - Whether to ask the forge.
 * @returns {Promise<CredentialInfo[]>} One entry per set variable.
 */
export function list(options?: ListOptions): Promise<CredentialInfo[]> {
  return listForge("bitbucket", options);
}
