import { type ForgeCredential, type ForgeOptions, resolveForge } from "./core/forge.ts";

export type { ForgeCredential, ForgeOptions } from "./core/forge.ts";

/**
 * Find a GitHub token: the explicit one, then GH_TOKEN, GITHUB_TOKEN, then `gh auth token`, then `hosts.yml` in `GH_CONFIG_DIR`.
 * @param options - Explicit token, self-hosted URL and account.
 * @returns {ForgeCredential | null} The token and its source, or null when nothing holds one.
 */
export function resolve(options?: ForgeOptions): ForgeCredential | null {
  return resolveForge("github", options);
}
