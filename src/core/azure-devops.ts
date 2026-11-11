/**
 * `az devops` hides its PAT in the keyring but leaves the default organization in a file:
 *
 *   [defaults]
 *   organization = https://dev.azure.com/contoso/
 *
 * knack lets `AZURE_DEVOPS_EXT__DEFAULTS_ORGANIZATION` override it. Yes, two underscores.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { compact, isRecord, nonEmptyString } from "./fields.ts";
import type { CredentialInfo } from "./types.ts";

/** The anonymous caller's id, which `az devops login` refuses. */
const ANONYMOUS_USER_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

/** An organization name, as the extension accepts it. */
const NAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;

/** Turns the sign-in redirect for a bad token into a 401. */
export const AZURE_DEVOPS_HEADERS: Readonly<Record<string, string>> = {
  "X-TFS-FedAuthRedirect": "Suppress",
};

/**
 * Find the directory `az devops` reads its config from.
 * @returns {string} The directory.
 */
function azureDevOpsConfigDir(): string {
  return (
    process.env.AZURE_DEVOPS_EXT__CONFIG_DIR ||
    process.env.AZURE_DEVOPS_EXT_CONFIG_DIR ||
    join(process.env.AZURE_CONFIG_DIR || join(homedir(), ".azure"), "azuredevops")
  );
}

/**
 * Find the organization `az devops` uses by default.
 * @returns {string | undefined} Its URL, when one is set.
 */
export function defaultOrganization(): string | undefined {
  const configured =
    process.env.AZURE_DEVOPS_EXT__DEFAULTS_ORGANIZATION ?? configuredOrganization();
  return configured ? organizationUrl(configured) : undefined;
}

/**
 * Read `[defaults] organization` from the config file.
 * @returns {string | undefined} The value as written.
 */
function configuredOrganization(): string | undefined {
  try {
    const content = readFileSync(join(azureDevOpsConfigDir(), "config"), "utf-8");
    return iniValue(content, "defaults", "organization");
  } catch {
    return undefined;
  }
}

/**
 * Read one INI value as configparser does, minus continuations and interpolation.
 * @param content - The file.
 * @param section - The section, matched exactly.
 * @param key - The key, lower case.
 * @returns {string | undefined} The first value.
 */
function iniValue(content: string, section: string, key: string): string | undefined {
  let current: string | undefined;
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    const header = /^\[(.+)\]/.exec(line);
    if (header !== null) {
      current = header[1];
      continue;
    }
    if (current !== section) continue;
    const pair = /^(.*?)\s*[=:]\s*(.*)$/.exec(line);
    if (pair?.[1]?.toLowerCase() === key) return pair[2];
  }
  return undefined;
}

/**
 * Cut an Azure DevOps Services URL down to its organization.
 * @param value - Any URL under the organization.
 * @returns {string | undefined} The organization URL, or undefined for any other host.
 */
export function organizationUrl(value: string): string | undefined {
  const url = URL.parse(value.trim());
  if (url?.protocol !== "https:" || url.port !== "" || url.username !== "") return undefined;
  if (url.password !== "") return undefined;
  return url.hostname === "dev.azure.com"
    ? devAzureOrganization(url.pathname)
    : visualStudioOrganization(url.hostname);
}

/**
 * Take the organization from a dev.azure.com path.
 * @param pathname - The URL's path.
 * @returns {string | undefined} `https://dev.azure.com/<org>`.
 */
function devAzureOrganization(pathname: string): string | undefined {
  const name = pathname.split("/").find((segment) => segment !== "");
  return name !== undefined && NAME.test(name) ? `https://dev.azure.com/${name}` : undefined;
}

/**
 * Take the organization from an old `<org>.visualstudio.com` host.
 * @param hostname - The URL's host.
 * @returns {string | undefined} `https://<org>.visualstudio.com`.
 */
function visualStudioOrganization(hostname: string): string | undefined {
  const name = hostname.endsWith(".visualstudio.com") ? hostname.slice(0, -17) : "";
  return name !== "vs-ssh" && NAME.test(name) ? `https://${hostname}` : undefined;
}

/**
 * Read `connectionData` as `az devops login` does, anonymous meaning a bad token.
 * @param body - The parsed answer.
 * @returns {ConnectionFacts} The state and account.
 */
export function connectionFacts(body: unknown): ConnectionFacts {
  const user = isRecord(body) ? body.authenticatedUser : undefined;
  if (!isRecord(user)) return { state: "unreachable", note: "Azure DevOps named no user" };
  if (user.id === ANONYMOUS_USER_ID) {
    return {
      state: "rejected",
      note: "Azure DevOps took it for anonymous, so it ignored the token",
    };
  }
  return compact<ConnectionFacts>({ state: "valid", account: accountOf(user) });
}

type ConnectionFacts = Pick<CredentialInfo, "state" | "account" | "note">;

/**
 * Name the user as the extension does.
 * @param user - The `authenticatedUser` identity.
 * @returns {string | undefined} The `Account` property, else the display name.
 */
function accountOf(user: Readonly<Record<string, unknown>>): string | undefined {
  const properties = isRecord(user.properties) ? user.properties : {};
  const account = isRecord(properties.Account) ? properties.Account.$value : undefined;
  return nonEmptyString(account) ?? nonEmptyString(user.providerDisplayName);
}
