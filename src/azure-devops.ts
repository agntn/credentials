import {
  defaultOrganization,
  organizationUrl,
  storedPatFor,
  storedPats,
} from "./core/azure-devops.ts";
import { compact } from "./core/fields.ts";
import {
  CONFIG_FILES,
  type ForgeCredential,
  type ForgeOptions,
  resolveForge,
  savedCredential,
} from "./core/forge.ts";
import { listForge } from "./core/forge-list.ts";
import type { CredentialInfo, ListOptions } from "./core/types.ts";

export type { ForgeCredential, ForgeOptions } from "./core/forge.ts";

/**
 * Find an Azure DevOps PAT: explicit, AZURE_DEVOPS_EXT_PAT, then the az devops PAT file.
 * @param options - Explicit token, and `baseURL` under the organization to use.
 * @returns {ForgeCredential | null} The token with its organization, or null.
 */
export function resolve(options?: ForgeOptions): ForgeCredential | null {
  const baseURL = options?.baseURL;
  const organization = baseURL ? organizationUrl(baseURL) : defaultOrganization();
  const credential = resolveForge("azure-devops", options) ?? fromPatFile(organization, options);
  if (credential === null) return null;
  return compact<ForgeCredential>({
    ...credential,
    username: credential.username ?? "",
    organization,
  });
}

/**
 * Read the saved PAT, never for a named account or a foreign `baseURL`.
 * @param organization - The organization URL, if there is one.
 * @param options - The caller's account and `baseURL`.
 * @returns {ForgeCredential | null} The saved PAT, or null.
 */
function fromPatFile(
  organization: string | undefined,
  options: ForgeOptions | undefined,
): ForgeCredential | null {
  if (options?.account !== undefined) return null;
  if (options?.baseURL && organization === undefined) return null;
  const pat = storedPatFor(storedPats(), organization);
  return pat === undefined ? null : savedCredential(pat.token, CONFIG_FILES["azure-devops"]);
}

/**
 * Describe AZURE_DEVOPS_EXT_PAT and the saved PATs, without the tokens.
 * @param options - Whether to ask each organization.
 * @returns {Promise<CredentialInfo[]>} The variable first, then the file in its own order.
 */
export function list(options?: ListOptions): Promise<CredentialInfo[]> {
  return listForge("azure-devops", options);
}
