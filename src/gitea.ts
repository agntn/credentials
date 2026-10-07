import { type ForgeCredential, type ForgeOptions, resolveForge } from "./core/forge.ts";
import { listForge } from "./core/forge-list.ts";
import type { CredentialInfo, ListOptions } from "./core/types.ts";

export type { ForgeCredential, ForgeOptions } from "./core/forge.ts";

/**
 * Find a Gitea token: the explicit one, then GITEA_TOKEN, then `tea/config.yml`, since tea prints no token.
 * @param options - Explicit token, self-hosted URL and account.
 * @returns {ForgeCredential | null} The token and its source, or null when nothing holds one.
 */
export function resolve(options?: ForgeOptions): ForgeCredential | null {
  return resolveForge("gitea", options);
}

/**
 * Describe every gitea credential this machine holds, without the tokens: each token
 * variable, then each CLI login. `verify` asks the forge about each one, on its own host.
 * @param options - Whether to ask the forge.
 * @returns {Promise<CredentialInfo[]>} One entry per credential.
 */
export function list(options?: ListOptions): Promise<CredentialInfo[]> {
  return listForge("gitea", options);
}
