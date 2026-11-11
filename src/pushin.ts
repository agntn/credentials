import {
  CONFIG_FILES,
  type ForgeCredential,
  type ForgeOptions,
  resolveForge,
  savedCredential,
} from "./core/forge.ts";
import { listForge } from "./core/forge-list.ts";
import { httpOrigin, PUSHIN_ORIGIN, punLoginFor, punLogins } from "./core/pun.ts";
import type { CredentialInfo, ListOptions } from "./core/types.ts";

export type { ForgeCredential, ForgeOptions } from "./core/forge.ts";

/**
 * Find a Pushin token: explicit, PUSHIN_TOKEN, then what `pun login` saved for the instance.
 * @param options - Explicit token, and `baseURL` of the instance, pushin.eu by default.
 * @returns {ForgeCredential | null} The token and its source, or null.
 */
export function resolve(options?: ForgeOptions): ForgeCredential | null {
  return resolveForge("pushin", options) ?? fromPunConfig(options);
}

/**
 * Read pun's token for the exact instance the caller targets.
 * @param options - The caller's account and `baseURL`.
 * @returns {ForgeCredential | null} The saved token, or null.
 */
function fromPunConfig(options: ForgeOptions | undefined): ForgeCredential | null {
  if (options?.account !== undefined) return null;
  const origin = options?.baseURL ? httpOrigin(options.baseURL) : PUSHIN_ORIGIN;
  const login = origin === undefined ? undefined : punLoginFor(punLogins(), origin);
  return login === undefined ? null : savedCredential(login.token, CONFIG_FILES.pushin);
}

/**
 * Describe PUSHIN_TOKEN and pun's saved logins, without the tokens.
 * @param options - Whether to ask each instance.
 * @returns {Promise<CredentialInfo[]>} The variable first, then `hosts.json` in file order.
 */
export function list(options?: ListOptions): Promise<CredentialInfo[]> {
  return listForge("pushin", options);
}
