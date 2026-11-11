/**
 * `az devops` hides its PAT in the keyring but leaves the default organization in a file:
 *
 *   [defaults]
 *   organization = https://dev.azure.com/contoso/
 *
 * knack lets `AZURE_DEVOPS_EXT__DEFAULTS_ORGANIZATION` override it. Yes, two underscores.
 *
 * When the keyring breaks on Linux, `az devops login` falls back to `personalAccessTokens`:
 *
 *   [azdevops-cli:https://dev.azure.com/contoso]
 *   personal access token = <pat>
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
  return iniFile("config").get("defaults")?.get("organization");
}

/** A PAT `az devops login` left in `personalAccessTokens`. */
export interface StoredPat {
  readonly token: string;
  /** Undefined for the PAT saved without an organization. */
  readonly organization: string | undefined;
}

const PAT_SECTION = "azdevops-cli:";
const DEFAULT_PAT_SECTION = "azdevops-cli: default";

/**
 * List the PATs `az devops login` saved to file. Linux only, like az.
 * @returns {StoredPat[]} One per section with a token, in file order.
 */
export function storedPats(): StoredPat[] {
  if (process.platform !== "linux") return [];
  return [...iniFile("personalAccessTokens")].flatMap(([section, values]): StoredPat[] => {
    const token = values.get("personal access token");
    if (!token) return [];
    if (section === DEFAULT_PAT_SECTION) return [{ token, organization: undefined }];
    const organization = patOrganization(section);
    return organization === undefined ? [] : [{ token, organization }];
  });
}

/**
 * Take the organization from a section name, canonical or not at all.
 * @param section - The section name.
 * @returns {string | undefined} The organization URL, or undefined.
 */
function patOrganization(section: string): string | undefined {
  if (!section.startsWith(PAT_SECTION)) return undefined;
  const name = section.slice(PAT_SECTION.length);
  return organizationUrl(name)?.toLowerCase() === name ? name : undefined;
}

/**
 * Pick the organization's own PAT, then the one saved without any.
 * @param pats - What `storedPats` found.
 * @param organization - The organization URL, if there is one.
 * @returns {StoredPat | undefined} The PAT, or undefined when neither is there.
 */
export function storedPatFor(
  pats: readonly StoredPat[],
  organization: string | undefined,
): StoredPat | undefined {
  const key = organization?.toLowerCase();
  return (
    pats.find((pat) => key !== undefined && pat.organization === key) ??
    pats.find((pat) => pat.organization === undefined)
  );
}

/**
 * Read one file from the az devops config dir.
 * @param name - The file name.
 * @returns {Map<string, Map<string, string>>} Its sections, empty without the file.
 */
function iniFile(name: string): Map<string, Map<string, string>> {
  try {
    return parseIni(readFileSync(join(azureDevOpsConfigDir(), name), "utf-8"));
  } catch {
    return new Map();
  }
}

/**
 * Parse INI like configparser, first section and key winning.
 * @param content - The file.
 * @returns {Map<string, Map<string, string>>} Keys, lower case, by section.
 */
function parseIni(content: string): Map<string, Map<string, string>> {
  const sections = new Map<string, Map<string, string>>();
  let current: Map<string, string> | undefined;
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    const header = /^\[(.+)\]/.exec(line)?.[1];
    if (header !== undefined) {
      current = sections.get(header) ?? new Map<string, string>();
      sections.set(header, current);
      continue;
    }
    const pair = iniPair(line);
    if (current !== undefined && pair !== undefined && !current.has(pair[0])) current.set(...pair);
  }
  return sections;
}

/**
 * Split a `key = value` or `key: value` line.
 * @param line - One trimmed line.
 * @returns {[string, string] | undefined} The key in lower case and its value, or undefined.
 */
function iniPair(line: string): [string, string] | undefined {
  const [, key, value] = /^(.*?)\s*[=:]\s*(.*)$/.exec(line) ?? [];
  return key === undefined ? undefined : [key.toLowerCase(), value ?? ""];
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
