import { defaultOrganization, organizationUrl } from "./core/azure-devops.ts";
import { compact } from "./core/fields.ts";
import { type ForgeCredential, type ForgeOptions, resolveForge } from "./core/forge.ts";
import { listForge } from "./core/forge-list.ts";
import type { CredentialInfo, ListOptions } from "./core/types.ts";

export type { ForgeCredential, ForgeOptions } from "./core/forge.ts";

/**
 * Find an Azure DevOps PAT: the explicit one, then AZURE_DEVOPS_EXT_PAT.
 * @param options - Explicit token, and `baseURL` under the organization to use.
 * @returns {ForgeCredential | null} The token with its organization, or null.
 */
export function resolve(options?: ForgeOptions): ForgeCredential | null {
  const credential = resolveForge("azure-devops", options);
  if (credential === null) return null;
  const baseURL = options?.baseURL;
  return compact<ForgeCredential>({
    ...credential,
    username: credential.username ?? "",
    organization: baseURL ? organizationUrl(baseURL) : defaultOrganization(),
  });
}

/**
 * Describe AZURE_DEVOPS_EXT_PAT, without the token.
 * @param options - Whether to ask the default organization.
 * @returns {Promise<CredentialInfo[]>} One entry when the variable is set.
 */
export function list(options?: ListOptions): Promise<CredentialInfo[]> {
  return listForge("azure-devops", options);
}
