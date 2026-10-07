import { type ForgeCredential, type ForgeOptions, resolveForge } from "./core/forge.ts";

export type { ForgeCredential, ForgeOptions } from "./core/forge.ts";

/**
 * Find a Gitea token: the explicit one, then GITEA_TOKEN, then `tea/config.yml`, since tea prints no token.
 * @param options - Explicit token, self-hosted URL and account.
 * @returns {ForgeCredential | null} The token and its source, or null when nothing holds one.
 */
export function resolve(options?: ForgeOptions): ForgeCredential | null {
  return resolveForge("gitea", options);
}
