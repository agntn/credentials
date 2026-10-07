/**
 * Every forge credential this machine holds, described without its token.
 *
 * `resolve` stops at the first hit; this walks every place `resolve` looks, so a caller
 * can see what is there, which one wins and, with `verify`, which ones still work.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  childKeys,
  configDir,
  DEFAULT_HOSTS,
  ENV_KEYS,
  extractYamlField,
  type Forge,
  getYamlMappingSection,
  ghConfigDir,
  hostnameOfUrl,
  parseYamlListEntries,
  runCli,
} from "./forge.ts";
import { compact, epoch } from "./fields.ts";
import type { CredentialInfo, CredentialSource, ListOptions } from "./types.ts";
import { field, type Probe, probe } from "./verify.ts";

/** A credential with the token `list` needs to verify it. Never leaves this module. */
interface Candidate {
  readonly info: CredentialInfo;
  readonly token: string | undefined;
  /** The endpoint on the credential's own host that answers with the token's user. */
  readonly verifyUrl: string | undefined;
}

/**
 * List every credential for one forge.
 * @param forge - The forge to list.
 * @param options - Whether to ask the forge about each token.
 * @returns {Promise<CredentialInfo[]>} Environment entries first, then CLI logins, in file order.
 */
export async function listForge(forge: Forge, options?: ListOptions): Promise<CredentialInfo[]> {
  const fromEnv = envCandidates(forge);
  const envWins = fromEnv.length > 0;
  const logins = loginCandidates(forge, envWins);
  const candidates = [...fromEnv, ...logins];
  if (options?.verify !== true) return candidates.map(({ info }) => info);
  return Promise.all(candidates.map((candidate) => verifyCandidate(forge, candidate)));
}

/**
 * Every set token variable. The first one wins in `resolve`, for any host.
 * @param forge - The forge whose variables to read.
 * @returns {Candidate[]} One entry per set variable, in lookup order.
 */
function envCandidates(forge: Forge): Candidate[] {
  const host = envHost(forge);
  const candidates: Candidate[] = [];
  for (const key of ENV_KEYS[forge]) {
    const token = process.env[key];
    if (token === undefined) continue;
    const anonymous = token === "";
    candidates.push({
      info: {
        service: forge,
        host: host ?? "any",
        source: "env",
        origin: key,
        active: candidates.length === 0,
        state: anonymous ? "anonymous" : "unchecked",
        ...(host === undefined && !anonymous
          ? { note: `${key} names no host, so it is never sent anywhere to check` }
          : {}),
      },
      token: anonymous ? undefined : token,
      verifyUrl: host === undefined ? undefined : userEndpoint(forge, `https://${host}`),
    });
  }
  return candidates;
}

/**
 * The host a forge's own CLI sends its token variable to. Gitea has no such CLI convention,
 * so `GITEA_TOKEN` has no host to be checked against.
 * @param forge - The forge.
 * @returns {string | undefined} The host, or undefined for Gitea.
 */
function envHost(forge: Forge): string | undefined {
  if (forge === "gitea") return undefined;
  if (forge === "gitlab") {
    const configured = process.env.GITLAB_HOST;
    if (configured) return hostnameOfUrl(configured) ?? configured;
  }
  return DEFAULT_HOSTS[forge];
}

/**
 * The logins the forge CLI keeps, from its config file.
 * @param forge - The forge.
 * @param envWins - Whether a token variable already wins over every login.
 * @returns {Candidate[]} One entry per login.
 */
function loginCandidates(forge: Forge, envWins: boolean): Candidate[] {
  try {
    switch (forge) {
      case "github":
        return ghLogins(envWins);
      case "gitlab":
        return glabLogins(envWins);
      case "gitea":
        return teaLogins(envWins);
    }
  } catch {
    // No config file means no logins.
    return [];
  }
}

/**
 * Logins in gh's `hosts.yml`. With gh installed the token comes from `gh auth token`,
 * which also reads the keyring; without it, only from the file.
 * @param envWins - Whether a token variable wins over every login.
 * @returns {Candidate[]} One entry per host and user.
 */
function ghLogins(envWins: boolean): Candidate[] {
  const content = readFileSync(join(ghConfigDir(), "hosts.yml"), "utf-8");
  return childKeys(content).flatMap((host) => {
    const section = getYamlMappingSection(content, host) ?? "";
    const activeUser = extractYamlField(section, "user");
    const users = getYamlMappingSection(section, "users");
    const logins = users === null ? [activeUser].filter((user) => user !== null) : childKeys(users);
    return logins.map((user): Candidate => {
      const fromCli = runCli("gh", ["auth", "token", `--hostname=${host}`, `--user=${user}`]);
      const userSection = users === null ? section : getYamlMappingSection(users, user);
      const fromFile = userSection === null ? null : extractYamlField(userSection, "oauth_token");
      const token = fromCli ?? fromFile;
      return loginCandidate({
        forge: "github",
        host,
        account: user,
        active: !envWins && user === activeUser,
        found: token === null ? undefined : fromCli === null ? "config" : "cli",
        origin: fromCli === null ? "gh hosts.yml" : "gh",
        token,
        verifyUrl: userEndpoint("github", `https://${host}`),
      });
    });
  });
}

/**
 * Hosts in glab's `config.yml`, with the token from the file or from `glab config get token`.
 * @param envWins - Whether a token variable wins over every login.
 * @returns {Candidate[]} One entry per host that has a token.
 */
function glabLogins(envWins: boolean): Candidate[] {
  const content = readFileSync(join(configDir(), "glab-cli", "config.yml"), "utf-8");
  const hosts = getYamlMappingSection(content, "hosts");
  if (hosts === null) return [];
  return childKeys(hosts).flatMap((host) => {
    const candidate = glabLogin(host, getYamlMappingSection(hosts, host) ?? "", envWins);
    return candidate === undefined ? [] : [candidate];
  });
}

/**
 * Build the entry for one glab host.
 * @param host - The host key.
 * @param section - Its lines in `config.yml`.
 * @param envWins - Whether a token variable wins over every login.
 * @returns {Candidate | undefined} The entry, or undefined when the host holds no token.
 */
function glabLogin(host: string, section: string, envWins: boolean): Candidate | undefined {
  const fromFile = extractYamlField(section, "token");
  const token = fromFile ?? runCli("glab", ["config", "get", "token", `--host=${host}`]);
  if (token === null) return undefined;
  const protocol = extractYamlField(section, "api_protocol") ?? "https";
  const apiHost = extractYamlField(section, "api_host") ?? host;
  return loginCandidate({
    forge: "gitlab",
    host,
    account: extractYamlField(section, "user") ?? undefined,
    active: !envWins,
    found: fromFile === null ? "cli" : "config",
    origin: fromFile === null ? "glab" : "glab config.yml",
    token,
    verifyUrl: userEndpoint("gitlab", `${protocol}://${apiHost}`),
    expiresAt: epoch(extractYamlField(section, "oauth2_expiry_date")),
  });
}

/**
 * Logins in tea's `config.yml`.
 * @param envWins - Whether a token variable wins over every login.
 * @returns {Candidate[]} One entry per login with a token.
 */
function teaLogins(envWins: boolean): Candidate[] {
  const content = readFileSync(join(configDir(), "tea", "config.yml"), "utf-8");
  const logins = getYamlMappingSection(content, "logins");
  if (logins === null) return [];
  // resolve takes the first login for a host, so only that one is active.
  const seen = new Set<string>();
  return parseYamlListEntries(logins).flatMap((entry) => {
    const host = entry.url ? hostnameOfUrl(entry.url) : null;
    if (!entry.token || !entry.url || host === null) return [];
    const first = !seen.has(host);
    seen.add(host);
    return [
      loginCandidate({
        forge: "gitea",
        host,
        account: entry.user || undefined,
        active: !envWins && first,
        found: "config",
        origin: "tea config.yml",
        token: entry.token,
        verifyUrl: userEndpoint("gitea", entry.url),
      }),
    ];
  });
}

interface LoginFacts {
  readonly forge: Forge;
  readonly host: string;
  readonly account?: string;
  readonly active: boolean;
  /** Where the token came from, or undefined when the CLI records the login but no token. */
  readonly found: CredentialSource | undefined;
  readonly origin: string;
  readonly token: string | null;
  readonly verifyUrl: string;
  readonly expiresAt?: number;
}

/**
 * Build the entry for one CLI login.
 * @param facts - What the config and the CLI say about it.
 * @returns {Candidate} The entry, expired when its recorded expiry has passed.
 */
function loginCandidate(facts: LoginFacts): Candidate {
  const expired = facts.expiresAt !== undefined && facts.expiresAt <= Date.now();
  const missing = facts.token === null;
  return {
    info: compact<CredentialInfo>({
      service: facts.forge,
      host: facts.host,
      source: facts.found ?? "config",
      origin: facts.origin,
      active: facts.active && !missing,
      state: expired ? "expired" : "unchecked",
      account: facts.account,
      expiresAt: facts.expiresAt,
      note: missing ? "the CLI records this login, but no token could be read" : undefined,
    }),
    token: facts.token ?? undefined,
    verifyUrl: facts.verifyUrl,
  };
}

/**
 * The endpoint that names the token's user, on the forge's own API.
 * @param forge - The forge.
 * @param origin - Scheme and host of the instance, or the full URL tea recorded.
 * @returns {string} The `/user` endpoint.
 */
function userEndpoint(forge: Forge, origin: string): string {
  const base = origin.replace(/\/+$/, "");
  switch (forge) {
    case "github":
      return base === "https://github.com" ? "https://api.github.com/user" : `${base}/api/v3/user`;
    case "gitlab":
      return `${base}/api/v4/user`;
    case "gitea":
      return `${base}/api/v1/user`;
  }
}

/**
 * Ask the forge about one token and fold the answer into its entry.
 * @param forge - The forge.
 * @param candidate - The entry, its token and endpoint.
 * @returns {Promise<CredentialInfo>} The entry with its state, and the account and scopes the forge reported.
 */
async function verifyCandidate(forge: Forge, candidate: Candidate): Promise<CredentialInfo> {
  const { info, token, verifyUrl } = candidate;
  if (token === undefined || verifyUrl === undefined || info.state === "expired") return info;
  const answer = await probe(verifyUrl, forge === "gitea" ? `token ${token}` : `Bearer ${token}`);
  return compact({ ...info, ...answerFacts(forge, answer) });
}

/**
 * Read the state, user, scopes and expiry out of a forge's answer.
 * @param forge - The forge that answered.
 * @param answer - The probe result.
 * @returns {Partial<CredentialInfo>} The fields to merge into the entry.
 */
function answerFacts(forge: Forge, answer: Probe): Partial<CredentialInfo> {
  if (answer.state !== "valid") return { state: answer.state, note: answer.note };
  const scopes = answer.headers.get("x-oauth-scopes") ?? "";
  return {
    state: "valid",
    account:
      field(answer.body, forge === "github" ? "login" : "username") ?? field(answer.body, "login"),
    scopes:
      scopes === ""
        ? undefined
        : scopes
            .split(",")
            .map((scope) => scope.trim())
            .filter(Boolean),
    expiresAt: epoch(answer.headers.get("github-authentication-token-expiration")),
  };
}
