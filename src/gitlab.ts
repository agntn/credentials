import { type ForgeCredential, type ForgeOptions, resolveForge } from "./core/forge.ts";
import { listForge } from "./core/forge-list.ts";
import type { CredentialInfo, ListOptions } from "./core/types.ts";

export type { ForgeCredential, ForgeOptions } from "./core/forge.ts";

/**
 * Find a GitLab token: the explicit one, then GITLAB_TOKEN, GL_TOKEN, GITLAB_PAT, then `glab config get token`, then `glab-cli/config.yml`.
 * @param options - Explicit token, self-hosted URL and account.
 * @returns {ForgeCredential | null} The token and its source, or null when nothing holds one.
 */
export function resolve(options?: ForgeOptions): ForgeCredential | null {
  return resolveForge("gitlab", options);
}

/**
 * Describe every gitlab credential this machine holds, without the tokens: each token
 * variable, then each CLI login. `verify` asks the forge about each one, on its own host.
 * @param options - Whether to ask the forge.
 * @returns {Promise<CredentialInfo[]>} One entry per credential.
 */
export function list(options?: ListOptions): Promise<CredentialInfo[]> {
  return listForge("gitlab", options);
}
