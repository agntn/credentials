/**
 * Token lookup shared by the git forges.
 *
 * Every forge tries the same chain:
 *   1. Explicit token (passed in options)
 *   2. Environment variables (GH_TOKEN, GITLAB_TOKEN, ...)
 *   3. The forge CLI (gh, glab, tea's git credential helper)
 *   4. The CLI's config file, for a machine with the config but not the CLI (hut prints
 *      no token, so for Sourcehut the file is the only step)
 *
 * Gitee has neither a CLI nor a config file, so its chain stops at the environment. So does
 * Bitbucket, which has no official CLI at all. Azure DevOps keeps its login in the keyring,
 * so `azure-devops.ts` reads only the file `az devops login` falls back to on Linux. `pun`
 * prints only its own file, so `pushin.ts` reads that file by instance URL instead.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { hutInstanceFor, hutInstances, hutOrigin, hutToken } from "./hut.ts";
import { ORIGIN_HOST, originLogin } from "./origin.ts";
import type { CredentialSource } from "./types.ts";

export type Forge =
  | "github"
  | "gitlab"
  | "gitea"
  | "gitee"
  | "sourcehut"
  | "bitbucket"
  | "azure-devops"
  | "pushin"
  | "cursor-origin";

/** A forge token and the step of the chain that found it. */
export interface ForgeCredential {
  readonly token: string;
  readonly source: CredentialSource;
  /** The variable, CLI or file it came from, such as `GL_TOKEN`. `token` if passed in. */
  readonly origin: string;
  /** Basic auth login sent with the token, empty on Azure DevOps. */
  readonly username?: string;
  /** Azure DevOps: the organization URL the token is for. */
  readonly organization?: string;
}

export interface ForgeOptions {
  /** Wins over everything else, even as an empty string, which asks for anonymous access. */
  readonly token?: string;
  /** Instance URL whose host picks the CLI login, or on Azure DevOps the organization. */
  readonly baseURL?: string;
  /**
   * Login to read instead of the active one. Only `gh` can pick among several logins,
   * so on every other forge a named account finds nothing past the environment.
   */
  readonly account?: string;
  /** Basic auth login for an explicit `token`, like a Bitbucket API token's email. */
  readonly username?: string;
}

export const DEFAULT_HOSTS: Record<Forge, string> = {
  github: "github.com",
  gitlab: "gitlab.com",
  gitea: "gitea.com",
  gitee: "gitee.com",
  sourcehut: "sr.ht",
  bitbucket: "bitbucket.org",
  "azure-devops": "dev.azure.com",
  pushin: "pushin.eu",
  "cursor-origin": ORIGIN_HOST,
};

export const ENV_KEYS: Record<Forge, readonly string[]> = {
  github: ["GH_TOKEN", "GITHUB_TOKEN"],
  gitlab: ["GITLAB_TOKEN", "GL_TOKEN", "GITLAB_PAT"],
  gitea: ["GITEA_TOKEN"],
  /** `GITEE_ACCESS_TOKEN` is the one Gitee's own MCP server reads. */
  gitee: ["GITEE_TOKEN", "GITEE_ACCESS_TOKEN"],
  sourcehut: ["SRHT_TOKEN"],
  /** Access tokens go out as a bearer, API tokens need their email. */
  bitbucket: ["BITBUCKET_TOKEN", "BITBUCKET_API_TOKEN"],
  /** The one `az devops` reads. */
  "azure-devops": ["AZURE_DEVOPS_EXT_PAT"],
  /** The one `pun` reads, ahead of its own login. */
  pushin: ["PUSHIN_TOKEN"],
  /** The bearer `origin` sends as is. `CURSOR_API_KEY` is not one: `origin` trades it. */
  "cursor-origin": ["CURSOR_AUTH_TOKEN"],
};

/** Each CLI's login file, under the name `list` shows. */
export const CONFIG_FILES = {
  github: "gh hosts.yml",
  gitlab: "glab config.yml",
  gitea: "tea config.yml",
  "azure-devops": "az devops personalAccessTokens",
  pushin: "pun hosts.json",
  "cursor-origin": "origin credentials.json",
} as const;

/** Token variables that only work with a login beside them. */
export const ENV_USERNAMES: Readonly<Record<string, string>> = {
  BITBUCKET_API_TOKEN: "BITBUCKET_EMAIL",
};

const CLI_TIMEOUT_MS = 5000;

/**
 * Resolve a token for one forge.
 * @param forge - The forge the token is for.
 * @param options - Explicit token, self-hosted URL and account.
 * @returns {ForgeCredential | null} The token, or null when no step of the chain has one.
 */
export function resolveForge(forge: Forge, options?: ForgeOptions): ForgeCredential | null {
  if (options?.token !== undefined) {
    const { token, username } = options;
    return username === undefined
      ? { token, source: "explicit", origin: "token" }
      : { token, source: "explicit", origin: "token", username };
  }

  const fromVariables = fromEnv(forge);
  if (fromVariables !== undefined) return fromVariables;

  const account = options?.account;
  if (account !== undefined && forge !== "github") return null;

  return fromLogin(forge, loginHost(forge, options?.baseURL), account);
}

/**
 * Read the first usable token variable. An empty one still ends the chain: `GH_TOKEN=` asks
 * for anonymous access.
 * @param forge - The forge whose variables to read.
 * @returns {ForgeCredential | undefined} The token, possibly empty, with any login.
 */
function fromEnv(forge: Forge): ForgeCredential | undefined {
  for (const key of ENV_KEYS[forge]) {
    const credential = envCredential(key);
    if (credential !== undefined) return credential;
  }
  return undefined;
}

/**
 * Read one token variable, and its login variable when it has one.
 * @param key - The token variable.
 * @returns {ForgeCredential | undefined} The token, or undefined when unset or missing its login.
 */
export function envCredential(key: string): ForgeCredential | undefined {
  const token = process.env[key];
  if (token === undefined) return undefined;
  const usernameKey = ENV_USERNAMES[key];
  if (usernameKey === undefined || token === "") return { token, source: "env", origin: key };
  const username = process.env[usernameKey];
  return username ? { token, source: "env", origin: key, username } : undefined;
}

/**
 * Ask the CLI first, then read its config file, for a machine that has the file but not the CLI.
 * @param forge - The forge whose CLI to ask.
 * @param hostname - The host whose login to read.
 * @param account - The login to read instead of the active one.
 * @returns {ForgeCredential | null} The token, or null when neither holds one.
 */
function fromLogin(forge: Forge, hostname: string, account?: string): ForgeCredential | null {
  return fromCli(forge, hostname, account) ?? fromConfig(forge, hostname, account);
}

/**
 * Wrap a token read from a login file.
 * @param token - The token, or null.
 * @param origin - The file's name.
 * @returns {ForgeCredential | null} The credential, or null.
 */
export function savedCredential(token: string | null, origin: string): ForgeCredential | null {
  return token === null ? null : { token, source: "config", origin };
}

/**
 * The host a CLI files its login under: the hostname for gh and glab, host and port for tea.
 * @param forge - The forge.
 * @param baseURL - The instance, or undefined for the forge's public host.
 * @returns {string} The host.
 */
function loginHost(forge: Forge, baseURL?: string): string {
  const host = baseURL && (forge === "gitea" ? hostOfUrl(baseURL) : hostnameOfUrl(baseURL));
  return host || DEFAULT_HOSTS[forge];
}

// --- CLI tools ---

function fromCli(forge: Forge, hostname: string, account?: string): ForgeCredential | null {
  switch (forge) {
    case "github": {
      // `--user` reads one login's token without switching the active one.
      const args = ["auth", "token", "--hostname", hostname];
      if (account !== undefined) args.push(`--user=${account}`);
      return askCli("gh", args);
    }
    case "gitlab":
      return askCli("glab", ["config", "get", "token", "--host", hostname]);
    case "gitea":
      return cliCredential(teaToken(hostname), "tea");
    case "cursor-origin":
      return hostname === ORIGIN_HOST ? askCli("origin", ["auth", "token"]) : null;
    default:
      return null;
  }
}

/**
 * Ask a CLI for its token.
 * @param command - The CLI.
 * @param args - Its arguments.
 * @returns {ForgeCredential | null} The credential, or null.
 */
function askCli(command: ForgeCli, args: readonly string[]): ForgeCredential | null {
  return cliCredential(runCli(command, args), command);
}

/**
 * Wrap a token a CLI printed.
 * @param token - The token, or null.
 * @param command - The CLI.
 * @returns {ForgeCredential | null} The credential, or null.
 */
function cliCredential(token: string | null, command: ForgeCli): ForgeCredential | null {
  return token === null ? null : { token, source: "cli", origin: command };
}

/**
 * Ask tea's git credential helper for a token. It renews an OAuth one about to expire first.
 * @param host - Host and port of the instance. tea takes the first login whose URL has them.
 * @param login - A login to read by name instead.
 * @returns {string | null} The token, or null when tea holds none whose login is on that host.
 */
export function teaToken(host: string, login?: string): string | null {
  const args = ["login", "helper", "get"];
  if (login !== undefined) args.push(`--login=${login}`);
  const lines = runCli("tea", args, `protocol=https\nhost=${host}\n\n`)?.split(/\r?\n/) ?? [];
  const field = (key: string): string =>
    lines.find((line) => line.startsWith(`${key}=`))?.slice(key.length + 1) ?? "";
  const answered = hostOfUrl(`${field("protocol")}://${field("host")}`);
  return answered === host ? field("password") || null : null;
}

/**
 * Token variables each CLI reports instead of the login it is asked about:
 * `glab config get token` prints `GITLAB_TOKEN` for any host. Every run hides them,
 * so a CLI answer always names a login, and the variables are read on their own.
 * tea's other commands build a login from `GITEA_TOKEN` or `GH_TOKEN` with `GITEA_INSTANCE_URL`.
 */
const CLI_TOKEN_VARIABLES: Record<ForgeCli, readonly string[]> = {
  gh: ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"],
  glab: ["GITLAB_TOKEN", "GITLAB_ACCESS_TOKEN", "OAUTH_TOKEN"],
  /** Without the endpoint, `origin` answers for origin.cursor.com, the host it was asked about. */
  origin: ["CURSOR_AUTH_TOKEN", "CURSOR_ORIGIN_ENDPOINT"],
  tea: ["GITEA_TOKEN", "GH_TOKEN", "GITEA_INSTANCE_URL"],
};

export type ForgeCli = "gh" | "glab" | "origin" | "tea";

/**
 * Run a CLI without the token variables it would answer with, and take its trimmed stdout.
 * @param command - The CLI.
 * @param args - Its arguments.
 * @param input - What to write to its stdin, for a CLI that reads a request there.
 * @returns {string | null} The output, or null when the CLI fails or prints nothing.
 */
export function runCli(command: ForgeCli, args: readonly string[], input?: string): string | null {
  try {
    const output = execFileSync(command, args, {
      encoding: "utf-8",
      timeout: CLI_TIMEOUT_MS,
      stdio: ["pipe", "pipe", "pipe"],
      env: withoutVariables(CLI_TOKEN_VARIABLES[command]),
      ...(input === undefined ? {} : { input }),
    });
    return output.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Copy the environment without some variables.
 * @param names - The variables to drop.
 * @returns {NodeJS.ProcessEnv} The copy.
 */
export function withoutVariables(names: readonly string[]): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of names) delete env[name];
  return env;
}

// --- Config files ---

function fromConfig(forge: Forge, hostname: string, account?: string): ForgeCredential | null {
  try {
    switch (forge) {
      case "github":
        return savedCredential(readGhConfig(hostname, account), CONFIG_FILES.github);
      case "gitlab":
        return savedCredential(readGlabConfig(hostname), CONFIG_FILES.gitlab);
      case "gitea":
        return savedCredential(readTeaConfig(hostname), CONFIG_FILES.gitea);
      case "sourcehut":
        return readHutConfig(hostname);
      case "cursor-origin":
        return savedCredential(readOriginConfig(hostname), CONFIG_FILES["cursor-origin"]);
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/**
 * Read gh CLI config at ~/.config/gh/hosts.yml
 *
 * Format:
 *   github.com:
 *     users:
 *       username:
 *         oauth_token: gho_...
 *     oauth_token: gho_...
 *     user: username
 *
 * A named account reads only its own `users` entry, never the active token.
 * @param hostname - The host whose login to read.
 * @param account - The login to read instead of the active one.
 * @returns {string | null} The stored token, or null when the host or login has none.
 */
function readGhConfig(hostname: string, account?: string): string | null {
  const content = readFileSync(join(ghConfigDir(), "hosts.yml"), "utf-8");
  const hostSection = getYamlMappingSection(content, hostname);
  if (!hostSection) return null;
  if (account !== undefined) {
    const usersSection = getYamlMappingSection(hostSection, "users");
    const userSection = usersSection && getYamlMappingSection(usersSection, account);
    return userSection ? extractYamlField(userSection, "oauth_token") : null;
  }
  return extractYamlField(hostSection, "oauth_token");
}

/**
 * Read glab config at ~/.config/glab-cli/config.yml
 *
 * Format:
 *   hosts:
 *     gitlab.com:
 *       token: glpat-...
 * @param hostname - The host whose token to read.
 * @returns {string | null} The stored token, or null when the host has none.
 */
function readGlabConfig(hostname: string): string | null {
  const content = readFileSync(join(configDir(), "glab-cli", "config.yml"), "utf-8");
  const hostsSection = getYamlMappingSection(content, "hosts");
  if (!hostsSection) return null;
  const hostSection = getYamlMappingSection(hostsSection, hostname);
  if (!hostSection) return null;
  return extractYamlField(hostSection, "token");
}

/**
 * Read tea config at ~/.config/tea/config.yml
 *
 * Format:
 *   logins:
 *     - name: gitea.com
 *       url: https://gitea.com
 *       token: ...
 *
 * Only token logins keep a token here. OAuth ones live in tea's encrypted store.
 * @param host - Host and port, matched against each login's name and URL host, as tea does.
 * @returns {string | null} The first matching login's token, or null.
 */
function readTeaConfig(host: string): string | null {
  const content = readFileSync(join(configDir(), "tea", "config.yml"), "utf-8");
  const loginsSection = getYamlMappingSection(content, "logins");
  if (!loginsSection) return null;

  for (const entry of parseYamlListEntries(loginsSection)) {
    if (!entry.token) continue;
    const urlHost = entry.url ? hostOfUrl(entry.url) : null;
    if (entry.name === host || urlHost === host) return entry.token;
  }
  return null;
}

/**
 * Read hut config at `hutConfigFile()`, the scfg file `hut.ts` describes.
 * @param hostname - Matched against each instance's domain, its subdomains and its service hosts.
 * @returns {ForgeCredential | null} The first matching instance's token, or null.
 */
function readHutConfig(hostname: string): ForgeCredential | null {
  const content = readFileSync(hutConfigFile(), "utf-8");
  const instance = hutInstanceFor(hutInstances(content), hostname);
  return instance === undefined ? null : savedCredential(hutToken(instance), hutOrigin(instance));
}

/**
 * Read the saved `origin` token while it's fresh and no CURSOR_API_KEY outranks it.
 * @param hostname - The host the caller targets.
 * @returns {string | null} The token, or null for another host, an expired token or a set key.
 */
function readOriginConfig(hostname: string): string | null {
  if (hostname !== ORIGIN_HOST || process.env.CURSOR_API_KEY) return null;
  const login = originLogin();
  if (login === undefined) return null;
  return login.expiresAt !== undefined && login.expiresAt <= Date.now() ? null : login.token;
}

// --- Helpers ---

export function configDir(): string {
  return process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
}

/**
 * Where hut keeps its config: Go's `os.UserConfigDir`, which skips XDG on macOS and Windows.
 * @returns {string} The path of `hut/config`.
 */
export function hutConfigFile(): string {
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "hut", "config");
  }
  if (process.platform === "win32") return join(process.env.APPDATA ?? "", "hut", "config");
  return join(configDir(), "hut", "config");
}

export function ghConfigDir(): string {
  return process.env.GH_CONFIG_DIR || join(configDir(), "gh");
}

export function hostnameOfUrl(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/**
 * Read a URL's host with its port, the way tea matches its logins.
 * @param url - Any URL.
 * @returns {string | null} The host, or null when the URL doesn't parse or has none.
 */
export function hostOfUrl(url: string): string | null {
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

/*
 * The CLI configs are small and regular, so a few line rules read them without
 * a YAML dependency. They cover the shapes documented above, not YAML at large.
 */

/**
 * Measure a line's indentation.
 * @param line - One line.
 * @returns {number} Its leading whitespace length.
 */
function indentOf(line: string): number {
  return /^\s*/.exec(line)?.[0].length ?? 0;
}

/**
 * Find the indentation of a section's own keys: the shallowest non-blank line. Lookups
 * stay at that depth, so a key nested inside another never answers for it.
 * @param lines - The section's lines.
 * @returns {number} The indentation, or 0 for an empty section.
 */
function topIndent(lines: readonly string[]): number {
  const indents = lines.filter((line) => line.trim() !== "").map(indentOf);
  return indents.length === 0 ? 0 : Math.min(...indents);
}

const MAPPING_KEY = /^(\s*)([^:#][^:]*)\s*:\s*(?:#.*)?$/;
const FIELD = /^\s*([A-Za-z0-9_]+)\s*:\s*(.+?)\s*$/;

export function getYamlMappingSection(content: string, key: string): string | null {
  const lines = content.split(/\r?\n/);
  const top = topIndent(lines);
  for (const [index, line] of lines.entries()) {
    const match = MAPPING_KEY.exec(line);
    const indent = match?.[1]?.length;
    const matchedKey = match?.[2];
    if (indent !== top || matchedKey === undefined) continue;
    if (stripQuotes(matchedKey.trim()) === key) return childLines(lines, index, indent);
  }
  return null;
}

/**
 * Collect the lines below `parent` indented deeper than it, blank lines included.
 * @param lines - Every line of the document.
 * @param parent - Index of the key line.
 * @param indent - Indentation of the key line.
 * @returns {string} The child lines joined back into one section.
 */
function childLines(lines: readonly string[], parent: number, indent: number): string {
  const children: string[] = [];
  for (const line of lines.slice(parent + 1)) {
    if (line.trim() && (/^\s*/.exec(line)?.[0].length ?? 0) <= indent) break;
    children.push(line);
  }
  return children.join("\n");
}

/**
 * List the keys of a mapping section at its own indentation, whatever their values.
 * @param section - The lines under a key, as `getYamlMappingSection` returns them.
 * @returns {string[]} The keys, in file order.
 */
export function childKeys(section: string): string[] {
  const keyed = section
    .split(/\r?\n/)
    .map((line) => /^(\s*)([^\s:#][^:]*):(?:\s|$)/.exec(line))
    .filter((match) => match !== null);
  const indent = Math.min(...keyed.map((match) => match[1]?.length ?? 0));
  return keyed
    .filter((match) => (match[1]?.length ?? 0) === indent)
    .map((match) => stripQuotes((match[2] ?? "").trim()));
}

/**
 * Read a field that sits directly in a section, never one nested deeper: in `hosts.yml`
 * the host's own `oauth_token` comes after every user's, and belongs to the active one.
 * @param section - The lines under a key, as `getYamlMappingSection` returns them.
 * @param field - The field name.
 * @returns {string | null} Its scalar value, or null when the section has no such field.
 */
export function extractYamlField(section: string, field: string): string | null {
  const lines = section.split(/\r?\n/);
  const top = topIndent(lines);
  for (const line of lines) {
    if (indentOf(line) !== top) continue;
    const match = FIELD.exec(line);
    const rawValue = match?.[2];
    if (match?.[1] !== field || rawValue === undefined) continue;
    return parseYamlScalar(rawValue);
  }
  return null;
}

export function parseYamlListEntries(section: string): Array<Record<string, string>> {
  const entries: Array<Record<string, string>> = [];
  let current: Record<string, string> | null = null;

  for (const line of section.split(/\r?\n/)) {
    const itemMatch = /^\s*-\s*(.*)$/.exec(line);
    if (itemMatch) {
      current = {};
      entries.push(current);
    }
    const field = fieldOf(itemMatch ? (itemMatch[1] ?? "") : line);
    if (current && field) current[field[0]] = field[1];
  }

  return entries;
}

/**
 * Split a `key: value` line.
 * @param line - One line of a list entry, without its `- ` marker.
 * @returns {[string, string] | undefined} The key and its scalar value, or undefined for any other line.
 */
function fieldOf(line: string): [string, string] | undefined {
  const match = FIELD.exec(line);
  const key = match?.[1];
  const rawValue = match?.[2];
  return key === undefined || rawValue === undefined
    ? undefined
    : [key, parseYamlScalar(rawValue) ?? ""];
}

function parseYamlScalar(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  const unquoted = stripQuotes(value);
  if (unquoted !== value) return unquoted;
  return value.split(/\s+#/)[0]?.trim() || null;
}

function stripQuotes(raw: string): string {
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  return raw;
}
