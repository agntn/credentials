/**
 * Token lookup shared by the git forges.
 *
 * Every forge tries the same chain:
 *   1. Explicit token (passed in options)
 *   2. Environment variables (GH_TOKEN, GITLAB_TOKEN, ...)
 *   3. The forge CLI (gh, glab)
 *   4. The CLI's config file, for a machine with the config but not the CLI (tea and hut
 *      print no token, so for Gitea and Sourcehut the file is the only step)
 *
 * Gitee has neither a CLI nor a config file, so its chain stops at the environment.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { hutInstanceFor, hutInstances, hutToken } from "./hut.ts";
import type { CredentialSource } from "./types.ts";

export type Forge = "github" | "gitlab" | "gitea" | "gitee" | "sourcehut";

/** A forge token and the step of the chain that found it. */
export interface ForgeCredential {
  readonly token: string;
  readonly source: CredentialSource;
}

export interface ForgeOptions {
  /** Wins over everything else, even as an empty string, which asks for anonymous access. */
  readonly token?: string;
  /** API or web URL of a self-hosted instance; its hostname picks the CLI login. */
  readonly baseURL?: string;
  /**
   * Login to read instead of the active one. Only `gh` can pick among several logins,
   * so on every other forge a named account finds nothing past the environment.
   */
  readonly account?: string;
}

export const DEFAULT_HOSTS: Record<Forge, string> = {
  github: "github.com",
  gitlab: "gitlab.com",
  gitea: "gitea.com",
  gitee: "gitee.com",
  sourcehut: "sr.ht",
};

export const ENV_KEYS: Record<Forge, readonly string[]> = {
  github: ["GH_TOKEN", "GITHUB_TOKEN"],
  gitlab: ["GITLAB_TOKEN", "GL_TOKEN", "GITLAB_PAT"],
  gitea: ["GITEA_TOKEN"],
  /** `GITEE_ACCESS_TOKEN` is the one Gitee's own MCP server reads. */
  gitee: ["GITEE_TOKEN", "GITEE_ACCESS_TOKEN"],
  sourcehut: ["SRHT_TOKEN"],
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
    return { token: options.token, source: "explicit" };
  }

  const envToken = fromEnv(forge);
  if (envToken !== undefined) return { token: envToken, source: "env" };

  const account = options?.account;
  if (account !== undefined && forge !== "github") return null;

  return fromLogin(forge, hostnameOf(forge, options?.baseURL), account);
}

/**
 * Read the first set token variable. An empty one still ends the chain: `GH_TOKEN=` asks for anonymous access.
 * @param forge - The forge whose variables to read.
 * @returns {string | undefined} The value, possibly empty, or undefined when none is set.
 */
function fromEnv(forge: Forge): string | undefined {
  for (const key of ENV_KEYS[forge]) {
    const value = process.env[key];
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * Ask the CLI first, then read its config file, for a machine that has the file but not the CLI.
 * @param forge - The forge whose CLI to ask.
 * @param hostname - The host whose login to read.
 * @param account - The login to read instead of the active one.
 * @returns {ForgeCredential | null} The token, or null when neither holds one.
 */
function fromLogin(forge: Forge, hostname: string, account?: string): ForgeCredential | null {
  const cliToken = fromCli(forge, hostname, account);
  if (cliToken !== null) return { token: cliToken, source: "cli" };
  const configToken = fromConfig(forge, hostname, account);
  return configToken === null ? null : { token: configToken, source: "config" };
}

function hostnameOf(forge: Forge, baseURL?: string): string {
  return (baseURL && hostnameOfUrl(baseURL)) || DEFAULT_HOSTS[forge];
}

// --- CLI tools ---

function fromCli(forge: Forge, hostname: string, account?: string): string | null {
  switch (forge) {
    case "github": {
      // `--user` reads one login's token without switching the active one.
      const args = ["auth", "token", "--hostname", hostname];
      if (account !== undefined) args.push(`--user=${account}`);
      return runCli("gh", args);
    }
    case "gitlab":
      return runCli("glab", ["config", "get", "token", "--host", hostname]);
    case "gitea":
    case "gitee":
    case "sourcehut":
      return null;
  }
}

/**
 * Run a CLI and take its trimmed stdout.
 * @param command - The CLI.
 * @param args - Its arguments.
 * @param hidden - Variables to keep from it, for a CLI that would print one of them instead
 * of the login asked for, as `glab config get token` prints `GITLAB_TOKEN` for any host.
 * @returns {string | null} The output, or null when the CLI fails or prints nothing.
 */
/**
 * Token variables each CLI reports instead of the login it is asked about:
 * `glab config get token` prints `GITLAB_TOKEN` for any host. Every run hides them,
 * so a CLI answer always names a login, and the variables are read on their own.
 */
const CLI_TOKEN_VARIABLES: Record<ForgeCli, readonly string[]> = {
  gh: ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"],
  glab: ["GITLAB_TOKEN", "GITLAB_ACCESS_TOKEN", "OAUTH_TOKEN"],
};

export type ForgeCli = "gh" | "glab";

export function runCli(command: ForgeCli, args: readonly string[]): string | null {
  try {
    const output = execFileSync(command, args, {
      encoding: "utf-8",
      timeout: CLI_TIMEOUT_MS,
      stdio: ["pipe", "pipe", "pipe"],
      env: withoutVariables(CLI_TOKEN_VARIABLES[command]),
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

function fromConfig(forge: Forge, hostname: string, account?: string): string | null {
  try {
    switch (forge) {
      case "github":
        return readGhConfig(hostname, account);
      case "gitlab":
        return readGlabConfig(hostname);
      case "gitea":
        return readTeaConfig(hostname);
      case "gitee":
        return null;
      case "sourcehut":
        return readHutConfig(hostname);
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
 * @param hostname - Matched against each login's name and URL host.
 * @returns {string | null} The first matching login's token, or null.
 */
function readTeaConfig(hostname: string): string | null {
  const content = readFileSync(join(configDir(), "tea", "config.yml"), "utf-8");
  const loginsSection = getYamlMappingSection(content, "logins");
  if (!loginsSection) return null;

  for (const entry of parseYamlListEntries(loginsSection)) {
    if (!entry.token) continue;
    const urlHostname = entry.url ? hostnameOfUrl(entry.url) : null;
    if (entry.name === hostname || urlHostname === hostname) return entry.token;
  }
  return null;
}

/**
 * Read hut config at `hutConfigFile()`, the scfg file `hut.ts` describes.
 * @param hostname - Matched against each instance's domain, its subdomains and its service hosts.
 * @returns {string | null} The first matching instance's token, or null.
 */
function readHutConfig(hostname: string): string | null {
  const content = readFileSync(hutConfigFile(), "utf-8");
  const instance = hutInstanceFor(hutInstances(content), hostname);
  return instance === undefined ? null : hutToken(instance);
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
