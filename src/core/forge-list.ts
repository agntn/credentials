/**
 * Every forge credential this machine holds, described without its token.
 *
 * `resolve` stops at the first hit; this walks every place `resolve` looks, so a caller
 * can see what is there, which one wins and, with `verify`, which ones still work.
 */

import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  childKeys,
  configDir,
  DEFAULT_HOSTS,
  ENV_KEYS,
  ENV_USERNAMES,
  envCredential,
  extractYamlField,
  type Forge,
  type ForgeCredential,
  getYamlMappingSection,
  ghConfigDir,
  hostnameOfUrl,
  hutConfigFile,
  parseYamlListEntries,
  runCli,
} from "./forge.ts";
import {
  AZURE_DEVOPS_HEADERS,
  connectionFacts,
  defaultOrganization,
  storedPatFor,
  storedPats,
} from "./azure-devops.ts";
import { compact, epoch, isRecord, nonEmptyString } from "./fields.ts";
import { hutInstanceFor, hutInstances, hutMetaQueryUrl, hutToken } from "./hut.ts";
import type { CredentialInfo, CredentialSource, ListOptions } from "./types.ts";
import { field, type Probe, type ProbeRequest, probe } from "./verify.ts";

/** A credential with the token `list` needs to verify it. Never leaves this module. */
interface Candidate {
  readonly info: CredentialInfo;
  readonly token: string | undefined;
  /** The login that goes out with the token as basic auth. */
  readonly username?: string;
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
 * Every set token variable. The first usable one wins in `resolve`, for any host.
 * @param forge - The forge whose variables to read.
 * @returns {Candidate[]} One entry per set variable, in lookup order.
 */
function envCandidates(forge: Forge): Candidate[] {
  const host = envHost(forge);
  const candidates: Candidate[] = [];
  for (const key of ENV_KEYS[forge]) {
    if (process.env[key] === undefined) continue;
    const taken = candidates.some(({ info }) => info.active);
    candidates.push(envCandidate({ forge, key, host, taken }));
  }
  return candidates;
}

/** Bitbucket's `/2.0/user` answers access tokens with 401 whether they work or not. */
const UNVERIFIABLE: Readonly<Record<string, string>> = {
  BITBUCKET_TOKEN:
    "Bitbucket's /user endpoint refuses access tokens, so BITBUCKET_TOKEN is never sent anywhere to check",
};

interface EnvFacts {
  readonly forge: Forge;
  readonly key: string;
  readonly host: string | undefined;
  /** Whether an earlier variable already wins. */
  readonly taken: boolean;
}

/**
 * Build the entry for one set token variable.
 * @param facts - The variable, its forge and host, and whether an earlier one wins.
 * @returns {Candidate} The entry; a token missing its login is listed but never active.
 */
function envCandidate(facts: EnvFacts): Candidate {
  const credential = envCredential(facts.key);
  if (credential?.token === "") {
    return {
      info: { ...envInfo(facts, true), state: "anonymous" },
      token: undefined,
      verifyUrl: undefined,
    };
  }
  const verifiable = UNVERIFIABLE[facts.key] === undefined;
  return {
    info: compact<CredentialInfo>({
      ...envInfo(facts, credential !== undefined),
      state: "unchecked",
      account: credential?.username,
      note: envNote(facts, credential),
    }),
    token: credential?.token,
    username: credential?.username,
    verifyUrl: verifiable ? envVerifyUrl(facts.forge, facts.host) : undefined,
  };
}

/**
 * The fields every entry for a token variable shares.
 * @param facts - The variable, its forge and host, and whether an earlier one wins.
 * @param usable - Whether `resolve` can use the variable at all.
 * @returns {Omit<CredentialInfo, "state">} The entry without its state.
 */
function envInfo(facts: EnvFacts, usable: boolean): Omit<CredentialInfo, "state"> {
  return {
    service: facts.forge,
    host: facts.host ?? "any",
    source: "env",
    origin: facts.key,
    active: !facts.taken && usable,
  };
}

/**
 * Say why a set variable is never checked or never used.
 * @param facts - The variable and the host it goes to, if it names one.
 * @param credential - What `resolve` reads from it, or undefined when its login is missing.
 * @returns {string | undefined} The note, or undefined when there is nothing to explain.
 */
function envNote(facts: EnvFacts, credential: ForgeCredential | undefined): string | undefined {
  const { key } = facts;
  if (credential === undefined) {
    return `${key} goes out with ${ENV_USERNAMES[key]}, which isn't set, so resolve skips it`;
  }
  if (facts.host !== undefined) return UNVERIFIABLE[key];
  return facts.forge === "azure-devops"
    ? `${key} has no organization (set one with az devops configure --defaults), so it is never sent anywhere to check`
    : `${key} names no host, so it is never sent anywhere to check`;
}

/**
 * The endpoint that checks a token variable, on the host its CLI sends it to.
 * @param forge - The forge.
 * @param host - That host, if the forge has one.
 * @returns {string | undefined} The endpoint, or undefined when the variable names no host.
 */
function envVerifyUrl(forge: Forge, host: string | undefined): string | undefined {
  if (host === undefined || forge === "sourcehut") return undefined;
  if (forge === "azure-devops") return `${host}/_apis/connectionData`;
  return forge === "gitee" ? `${giteeApiBase()}/user` : userEndpoint(forge, `https://${host}`);
}

/**
 * Where Gitee's MCP server sends its token: `GITEE_API_BASE`, or gitee.com's v5 API.
 * @returns {string} The API base, without a trailing slash.
 */
function giteeApiBase(): string {
  return (process.env.GITEE_API_BASE || "https://gitee.com/api/v5").replace(/\/+$/, "");
}

/**
 * The host a forge's own CLI sends its token variable to. Gitea and Sourcehut have no such
 * CLI convention, so `GITEA_TOKEN` and `SRHT_TOKEN` have no host to be checked against.
 * Gitee's is the host of `GITEE_API_BASE`, when it has one.
 * Azure DevOps' is its default organization.
 * @param forge - The forge.
 * @returns {string | undefined} The host, or undefined when the variable names none.
 */
function envHost(forge: Forge): string | undefined {
  if (forge === "gitea" || forge === "sourcehut") return undefined;
  if (forge === "gitee") return hostnameOfUrl(giteeApiBase()) || undefined;
  if (forge === "azure-devops") return defaultOrganization();
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
      case "gitee":
      case "bitbucket":
        return [];
      case "azure-devops":
        return azureDevOpsLogins(envWins);
      case "sourcehut":
        return hutLogins(envWins);
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

/**
 * Instances in hut's `config`, each with its `access-token` or what its
 * `access-token-cmd` prints. resolve takes the first instance for a host, so only that one is active.
 * @param envWins - Whether a token variable wins over every login.
 * @returns {Candidate[]} One entry per instance.
 */
function hutLogins(envWins: boolean): Candidate[] {
  const content = readFileSync(hutConfigFile(), "utf-8");
  const instances = hutInstances(content);
  return instances.map((instance) =>
    loginCandidate({
      forge: "sourcehut",
      host: instance.origin,
      active: !envWins && hutInstanceFor(instances, instance.origin) === instance,
      found: "config",
      origin: instance.command === undefined ? "hut config" : "hut access-token-cmd",
      token: hutToken(instance),
      verifyUrl: hutMetaQueryUrl(instance),
    }),
  );
}

/**
 * Saved az devops PATs. One without an organization goes to the default.
 * @param envWins - Whether AZURE_DEVOPS_EXT_PAT wins over every saved PAT.
 * @returns {Candidate[]} One entry per saved PAT.
 */
function azureDevOpsLogins(envWins: boolean): Candidate[] {
  const pats = storedPats();
  const fallback = defaultOrganization();
  const active = storedPatFor(pats, fallback);
  return pats.map((pat) => {
    const host = pat.organization ?? fallback;
    return loginCandidate({
      forge: "azure-devops",
      host: host ?? "any",
      active: !envWins && pat === active,
      found: "config",
      origin: "az devops personalAccessTokens",
      token: pat.token,
      verifyUrl: host === undefined ? undefined : `${host}/_apis/connectionData`,
      note:
        host === undefined
          ? "this PAT has no organization (set one with az devops configure --defaults), so it is never sent anywhere to check"
          : undefined,
    });
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
  /** Undefined when there's no host to check it on. */
  readonly verifyUrl: string | undefined;
  readonly expiresAt?: number;
  /** Why the entry is never checked. */
  readonly note?: string | undefined;
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
      note: missing ? "the CLI records this login, but no token could be read" : facts.note,
    }),
    token: facts.token ?? undefined,
    verifyUrl: facts.verifyUrl,
  };
}

/**
 * The endpoint that names the token's user, on the forge's own API. Sourcehut's sits on
 * meta, which hut can move, so `hutMetaQueryUrl` builds it; Gitee's on `giteeApiBase()`.
 * @param forge - The forge.
 * @param origin - Scheme and host of the instance, or the full URL tea recorded.
 * @returns {string} The `/user` endpoint.
 */
function userEndpoint(
  forge: Exclude<Forge, "sourcehut" | "gitee" | "azure-devops">,
  origin: string,
): string {
  const base = origin.replace(/\/+$/, "");
  switch (forge) {
    case "github":
      return base === "https://github.com" ? "https://api.github.com/user" : `${base}/api/v3/user`;
    case "gitlab":
      return `${base}/api/v4/user`;
    case "gitea":
      return `${base}/api/v1/user`;
    case "bitbucket":
      return "https://api.bitbucket.org/2.0/user";
  }
}

/** meta.sr.ht answers a refused token with 400 and `ERR_UNAUTHORIZED`, not 401. */
const SOURCEHUT_REFUSALS = [400, 401, 403];
const SOURCEHUT_ME = JSON.stringify({ query: "{ me { canonicalName } }" });

/** Bitbucket answers a missing scope with 403, not a bad token. */
const BITBUCKET_REFUSALS = [401];

/**
 * Build the request that shows a forge one token.
 * @param forge - The forge.
 * @param credential - The token, and the login that goes with it as basic auth.
 * @returns {ProbeRequest} The header, and for Sourcehut the GraphQL query and its refusals.
 */
function probeRequest(
  forge: Forge,
  credential: Pick<Candidate, "token" | "username">,
): ProbeRequest {
  const { token, username } = credential;
  if (forge === "azure-devops") {
    return { authorization: basicAuth("", token), headers: AZURE_DEVOPS_HEADERS };
  }
  if (username !== undefined) {
    return { authorization: basicAuth(username, token), refusals: BITBUCKET_REFUSALS };
  }
  switch (forge) {
    case "gitea":
    case "gitee":
      return { authorization: `token ${token}` };
    case "sourcehut":
      return { authorization: `Bearer ${token}`, refusals: SOURCEHUT_REFUSALS, body: SOURCEHUT_ME };
    default:
      return { authorization: `Bearer ${token}` };
  }
}

/**
 * Build a basic auth header.
 * @param username - The login, empty for Azure DevOps.
 * @param token - The token that goes in as the password.
 * @returns {string} The `Authorization` value.
 */
function basicAuth(username: string, token: string | undefined): string {
  return `Basic ${Buffer.from(`${username}:${token ?? ""}`).toString("base64")}`;
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
  const answer = await probe(verifyUrl, probeRequest(forge, candidate));
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
  if (forge === "azure-devops") return connectionFacts(answer.body);
  const scopes = answer.headers.get("x-oauth-scopes") ?? "";
  return {
    state: "valid",
    account: accountOf(forge, answer.body),
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

/**
 * Read the user out of a forge's answer: `login` on GitHub and Gitee, `username` on GitLab,
 * Gitea and Bitbucket, `data.me.canonicalName` (`~name`) from Sourcehut's GraphQL.
 * @param forge - The forge that answered.
 * @param body - The parsed body.
 * @returns {string | undefined} The user, when the answer names one.
 */
function accountOf(forge: Forge, body: unknown): string | undefined {
  if (forge === "sourcehut") {
    const data = isRecord(body) ? body.data : undefined;
    const me = isRecord(data) ? data.me : undefined;
    return isRecord(me) ? nonEmptyString(me.canonicalName) : undefined;
  }
  return field(body, forge === "github" ? "login" : "username") ?? field(body, "login");
}
