import { type ForgeCredential, type ForgeOptions, resolveForge } from "./core/forge.ts";
import { listForge } from "./core/forge-list.ts";
import type { CredentialInfo, ListOptions } from "./core/types.ts";

export type { ForgeCredential, ForgeOptions } from "./core/forge.ts";

/**
 * Find a GitHub token: the explicit one, then GH_TOKEN, GITHUB_TOKEN, then `gh auth token`, then `hosts.yml` in `GH_CONFIG_DIR`.
 * @param options - Explicit token, self-hosted URL and account.
 * @returns {ForgeCredential | null} The token and its source, or null when nothing holds one.
 */
export function resolve(options?: ForgeOptions): ForgeCredential | null {
  return resolveForge("github", options);
}

/**
 * Describe every github credential this machine holds, without the tokens: each token
 * variable, then each CLI login. `verify` asks the forge about each one, on its own host.
 * @param options - Whether to ask the forge.
 * @returns {Promise<CredentialInfo[]>} One entry per credential.
 */
export function list(options?: ListOptions): Promise<CredentialInfo[]> {
  return listForge("github", options);
}
