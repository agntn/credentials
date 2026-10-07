import { type ForgeCredential, type ForgeOptions, resolveForge } from "./core/forge.ts";

export type { ForgeCredential, ForgeOptions } from "./core/forge.ts";

/**
 * Find a GitLab token: the explicit one, then GITLAB_TOKEN, GL_TOKEN, GITLAB_PAT, then `glab config get token`, then `glab-cli/config.yml`.
 * @param options - Explicit token, self-hosted URL and account.
 * @returns {ForgeCredential | null} The token and its source, or null when nothing holds one.
 */
export function resolve(options?: ForgeOptions): ForgeCredential | null {
  return resolveForge("gitlab", options);
}
