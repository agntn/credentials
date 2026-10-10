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
  CONFIG_FILES,
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
  hostOfUrl,
  hutConfigFile,
  parseYamlListEntries,
  runCli,
  teaToken,
} from "./forge.ts";
import {
  AZURE_DEVOPS_HEADERS,
  connectionFacts,
  defaultOrganization,
  storedPatFor,
  storedPats,
} from "./azure-devops.ts";
import { compact, epoch, epochSeconds, isRecord, nonEmptyString } from "./fields.ts";
import { hutInstanceFor, hutInstances, hutMetaQueryUrl, hutOrigin, hutToken } from "./hut.ts";
import { ORIGIN_API, ORIGIN_HOST, originApiBase, originLogin } from "./origin.ts";
import { httpOrigin, PUSHIN_ORIGIN, punLoginFor, punLogins } from "./pun.ts";
import type { CredentialInfo, CredentialSource, CredentialState, ListOptions } from "./types.ts";
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
  if (facts.forge === "azure-devops") {
    return `${key} has no organization (set one with az devops configure --defaults), so it is never sent anywhere to check`;
  }
  return facts.forge === "gitea"
    ? `${key} names no host without a valid GITEA_INSTANCE_URL, so it is never sent anywhere to check`
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
  if (forge === "pushin") return `${pushinUrl().replace(/\/+$/, "")}/api/v1/user`;
  if (forge === "cursor-origin") return `${originApiBase()}/rate_limit`;
  if (forge === "gitea") return userEndpoint(forge, process.env.GITEA_INSTANCE_URL ?? "");
  return forge === "gitee" ? `${giteeApiBase()}/user` : userEndpoint(forge, `https://${host}`);
}

/**
 * Where pun sends PUSHIN_TOKEN: `PUSHIN_URL`, or pushin.eu.
 * @returns {string} The instance URL, as set.
 */
function pushinUrl(): string {
  return process.env.PUSHIN_URL || PUSHIN_ORIGIN;
}

/**
 * Where Gitee's MCP server sends its token: `GITEE_API_BASE`, or gitee.com's v5 API.
 * @returns {string} The API base, without a trailing slash.
 */
function giteeApiBase(): string {
  return (process.env.GITEE_API_BASE || "https://gitee.com/api/v5").replace(/\/+$/, "");
}

/**
 * The instance tea pairs `GITEA_TOKEN` with: `GITEA_INSTANCE_URL`.
 * @returns {string | undefined} Its host and port, as tea tells logins apart, or undefined when it is unset or doesn't parse.
 */
function giteaInstanceHost(): string | undefined {
  const url = process.env.GITEA_INSTANCE_URL;
  return (url && hostOfUrl(url)) || undefined;
}

/**
 * The host a forge's own CLI sends its token variable to. Sourcehut has no such CLI
 * convention, so `SRHT_TOKEN` has no host to be checked against. Gitea's is the host of
 * `GITEA_INSTANCE_URL`, Gitee's of `GITEE_API_BASE`, and Pushin's of `PUSHIN_URL`, when it has one.
 * Azure DevOps' is its default organization.
 * @param forge - The forge.
 * @returns {string | undefined} The host, or undefined when the variable names none.
 */
function envHost(forge: Forge): string | undefined {
  if (forge === "sourcehut") return undefined;
  const paired = PAIRED_HOSTS[forge];
  if (paired !== undefined) return paired();
  if (forge === "gitlab") {
    const configured = process.env.GITLAB_HOST;
    if (configured) return hostnameOfUrl(configured) ?? configured;
  }
  return DEFAULT_HOSTS[forge];
}

/** Forges whose token variable goes wherever another variable points. */
const PAIRED_HOSTS: Partial<Record<Forge, () => string | undefined>> = {
  gitea: giteaInstanceHost,
  gitee: () => hostnameOfUrl(giteeApiBase()) || undefined,
  "azure-devops": defaultOrganization,
  pushin: pushinHost,
  "cursor-origin": originHost,
};

/**
 * The host behind `CURSOR_ORIGIN_ENDPOINT`, origin.cursor.com for its own API.
 * @returns {string | undefined} The host, or undefined for an endpoint `origin` won't trust.
 */
function originHost(): string | undefined {
  const base = originApiBase();
  if (base === undefined) return undefined;
  return base === ORIGIN_API ? ORIGIN_HOST : new URL(base).host;
}

/**
 * The host of `PUSHIN_URL`, port included.
 * @returns {string | undefined} The host, or undefined for a non-http URL.
 */
function pushinHost(): string | undefined {
  const origin = httpOrigin(pushinUrl());
  return origin === undefined ? undefined : new URL(origin).host;
}

/** Readers for the logins each forge CLI saves. */
const LOGIN_READERS: Partial<Record<Forge, (envWins: boolean) => Candidate[]>> = {
  github: ghLogins,
  gitlab: glabLogins,
  gitea: teaLogins,
  sourcehut: hutLogins,
  "azure-devops": azureDevOpsLogins,
  pushin: punLoginCandidates,
  "cursor-origin": originLoginCandidates,
};

/**
 * The logins the forge CLI keeps, from its config file.
 * @param forge - The forge.
 * @param envWins - Whether a token variable already wins over every login.
 * @returns {Candidate[]} One entry per login.
 */
function loginCandidates(forge: Forge, envWins: boolean): Candidate[] {
  try {
    return LOGIN_READERS[forge]?.(envWins) ?? [];
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
        origin: fromCli === null ? CONFIG_FILES.github : "gh",
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
    origin: fromFile === null ? "glab" : CONFIG_FILES.gitlab,
    token,
    verifyUrl: userEndpoint("gitlab", `${protocol}://${apiHost}`),
    expiresAt: epoch(extractYamlField(section, "oauth2_expiry_date")),
  });
}

/**
 * Every tea login, token, OAuth or SSH. A host's first login with a token is the active one.
 * @param envWins - Whether a token variable wins over every login.
 * @returns {Candidate[]} One entry per login with a URL.
 */
function teaLogins(envWins: boolean): Candidate[] {
  const content = readFileSync(join(configDir(), "tea", "config.yml"), "utf-8");
  const logins = getYamlMappingSection(content, "logins");
  if (logins === null) return [];
  const seen = new Set<string>();
  return parseYamlListEntries(logins).flatMap((entry) => {
    const login = teaLogin(entry);
    if (login === undefined) return [];
    const first = login.token !== null && !seen.has(login.host);
    if (login.token !== null) seen.add(login.host);
    return [loginCandidate({ ...login, active: !envWins && first })];
  });
}

type TeaEntry = Readonly<Record<string, string>>;

/**
 * Gather what the file and tea say about one login.
 * @param entry - The login's fields in `config.yml`.
 * @returns {Omit<LoginFacts, "active"> | undefined} The facts, or undefined without a usable URL.
 */
function teaLogin(entry: TeaEntry): Omit<LoginFacts, "active"> | undefined {
  const instance = teaInstance(entry.url);
  if (instance === undefined) return undefined;
  const found = teaLoginToken(entry, instance.host);
  const status = teaVerdict(entry, found.source);
  return {
    forge: "gitea",
    host: instance.host,
    account: status?.account ?? (entry.user || undefined),
    found: found.source,
    origin: found.origin,
    token: found.token,
    verifyUrl: userEndpoint("gitea", instance.url),
    expiresAt: status === undefined ? epochSeconds(entry.token_expiry) : status.expiresAt,
    checked: status,
    missingReason: sshReason(entry),
  };
}

/** A tea login's instance. */
interface TeaInstance {
  readonly url: string;
  /** Host and port, which tea tells its logins apart by. */
  readonly host: string;
}

/**
 * Read the host a login is listed under from its URL.
 * @param url - The login's URL.
 * @returns {TeaInstance | undefined} The instance, or undefined when the URL doesn't parse.
 */
function teaInstance(url: string | undefined): TeaInstance | undefined {
  const host = url ? hostOfUrl(url) : null;
  return url && host ? { url, host } : undefined;
}

/** A tea login's token and where it came from. */
interface TeaToken {
  readonly token: string | null;
  readonly source: CredentialSource | undefined;
  readonly origin: string;
}

/**
 * Take a login's token from tea, or from the file when tea is missing.
 * @param entry - The login's fields.
 * @param host - Host and port of its instance.
 * @returns {TeaToken} The token and where it came from.
 */
function teaLoginToken(entry: TeaEntry, host: string): TeaToken {
  const fromCli = entry.name ? teaToken(host, entry.name) : null;
  if (fromCli !== null) return { token: fromCli, source: "cli", origin: "tea" };
  const fromFile = entry.token || null;
  return {
    token: fromFile,
    source: fromFile === null ? undefined : "config",
    origin: CONFIG_FILES.gitea,
  };
}

/** tea's own verdict on a login it renews. */
interface TeaStatus {
  readonly state: CredentialState;
  readonly note?: string;
  readonly account?: string;
  readonly expiresAt?: number;
}

/**
 * Let tea check the logins it renews itself, the OAuth ones. The rest wait for `verify`.
 * @param entry - The login's fields.
 * @param source - Where its token came from.
 * @returns {TeaStatus | undefined} tea's verdict, or undefined when tea isn't asked or gives none.
 */
function teaVerdict(entry: TeaEntry, source: CredentialSource | undefined): TeaStatus | undefined {
  const renewed = entry.auth_method === "oauth" || Boolean(entry.refresh_token);
  if (source !== "cli" || !renewed || !entry.name) return undefined;
  return teaStatus(entry.name);
}

/**
 * Ask `tea login status` about one login. It goes online, `verify` or not, like `cf auth whoami`.
 * @param name - The login's name.
 * @returns {TeaStatus | undefined} The verdict, or undefined when tea gave none.
 */
function teaStatus(name: string): TeaStatus | undefined {
  const parsed = readJson(runCli("tea", ["login", "status", "--output", "json", "--", name]));
  const statuses: readonly unknown[] = Array.isArray(parsed) ? parsed : [];
  const status = statuses.find((entry) => field(entry, "name") === name);
  if (status === undefined) return undefined;
  const valid = field(status, "valid") === "true";
  return compact<TeaStatus>({
    state: valid ? "valid" : "rejected",
    note: valid ? undefined : "tea login status couldn't log in with it",
    account: field(status, "user"),
    expiresAt: epoch(field(status, "token_expiry")),
  });
}

/**
 * Parse JSON without letting out the SyntaxError, which quotes its input.
 * @param text - CLI output, if any.
 * @returns {unknown} The value, or undefined when it isn't JSON.
 */
function readJson(text: string | null): unknown {
  try {
    return JSON.parse(text ?? "");
  } catch {
    return undefined;
  }
}

/**
 * Say why a login that signs with an SSH certificate or agent key has no token.
 * @param entry - The login's fields.
 * @returns {string | undefined} The reason it has no token, or undefined for any other login.
 */
function sshReason(entry: TeaEntry): string | undefined {
  return entry.ssh_certificate_principal || entry.ssh_key_agent_pub
    ? "tea signs its requests with an SSH key for this login, so there's no token to read"
    : undefined;
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
      origin: hutOrigin(instance),
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
      origin: CONFIG_FILES["azure-devops"],
      token: pat.token,
      verifyUrl: host === undefined ? undefined : `${host}/_apis/connectionData`,
      note:
        host === undefined
          ? "this PAT has no organization (set one with az devops configure --defaults), so it is never sent anywhere to check"
          : undefined,
    });
  });
}

/**
 * Logins in pun's `hosts.json`, checked where pun sends them.
 * @param envWins - Whether PUSHIN_TOKEN wins over every login.
 * @returns {Candidate[]} One entry per saved instance.
 */
function punLoginCandidates(envWins: boolean): Candidate[] {
  const logins = punLogins();
  return logins.map((login) =>
    loginCandidate({
      forge: "pushin",
      host: new URL(login.origin).host,
      active: !envWins && punLoginFor(logins, login.origin) === login,
      found: "config",
      origin: CONFIG_FILES.pushin,
      token: login.token,
      verifyUrl: `${login.base}/api/v1/user`,
    }),
  );
}

/**
 * What `origin auth token` falls back on: CURSOR_API_KEY, then the saved login.
 * @param envWins - Whether CURSOR_AUTH_TOKEN wins over both.
 * @returns {Candidate[]} The key first, then the login.
 */
function originLoginCandidates(envWins: boolean): Candidate[] {
  const keySet = Boolean(process.env.CURSOR_API_KEY);
  const login = originLogin();
  const candidates: Candidate[] = [];
  if (keySet) candidates.push(originKeyCandidate(envWins));
  if (login === undefined) return candidates;
  const saved = loginCandidate({
    forge: "cursor-origin",
    host: ORIGIN_HOST,
    active: !envWins && !keySet,
    found: "config",
    origin: CONFIG_FILES["cursor-origin"],
    token: login.token,
    verifyUrl: `${ORIGIN_API}/rate_limit`,
    expiresAt: login.expiresAt,
  });
  return [...candidates, withRefreshNote(saved)];
}

/**
 * Describe CURSOR_API_KEY, which `origin` trades for a token and never sends itself.
 * @param envWins - Whether CURSOR_AUTH_TOKEN wins over it.
 * @returns {Candidate} An entry with no token, so it is never checked.
 */
function originKeyCandidate(envWins: boolean): Candidate {
  return {
    info: {
      service: "cursor-origin",
      host: ORIGIN_HOST,
      source: "cli",
      origin: "CURSOR_API_KEY",
      active: !envWins,
      state: "unchecked",
      note: "origin auth token trades this key for a short-lived token, so the key itself is never sent anywhere to check",
    },
    token: undefined,
    verifyUrl: undefined,
  };
}

/**
 * Say that an expired saved token is not a dead login: `origin` refreshes it.
 * @param candidate - The saved login.
 * @returns {Candidate} The same entry, with a note once its token has expired.
 */
function withRefreshNote(candidate: Candidate): Candidate {
  if (candidate.info.state !== "expired") return candidate;
  const note = "the saved access token has expired, and the next origin command refreshes it";
  return { ...candidate, info: { ...candidate.info, note } };
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
  /** The CLI's own verdict on a login it checks itself. `verify` leaves such a login alone. */
  readonly checked?: Pick<CredentialInfo, "state" | "note">;
  /** Why there is no token, when the CLI's records say. */
  readonly missingReason?: string;
}

/**
 * Build the entry for one CLI login.
 * @param facts - What the config and the CLI say about it.
 * @returns {Candidate} The entry, expired when its recorded expiry has passed.
 */
function loginCandidate(facts: LoginFacts): Candidate {
  const missing = facts.token === null;
  return {
    info: compact<CredentialInfo>({
      service: facts.forge,
      host: facts.host,
      source: facts.found ?? "config",
      origin: facts.origin,
      active: facts.active && !missing,
      state: loginState(facts),
      account: facts.account,
      expiresAt: facts.expiresAt,
      note: missing
        ? (facts.missingReason ?? "the CLI records this login, but no token could be read")
        : (facts.checked?.note ?? facts.note),
    }),
    token: facts.checked === undefined ? (facts.token ?? undefined) : undefined,
    verifyUrl: facts.verifyUrl,
  };
}

/**
 * Expired past the recorded expiry, otherwise the CLI's own verdict, otherwise unchecked.
 * @param facts - What the config and the CLI say about it.
 * @returns {CredentialState} The state.
 */
function loginState(facts: LoginFacts): CredentialState {
  if (facts.expiresAt !== undefined && facts.expiresAt <= Date.now()) return "expired";
  return facts.checked?.state ?? "unchecked";
}

/**
 * The endpoint that names the token's user, on the forge's own API. Sourcehut's sits on
 * meta, which hut can move, so `hutMetaQueryUrl` builds it; Gitee's on `giteeApiBase()`.
 * @param forge - The forge.
 * @param origin - Scheme and host of the instance, or the full URL tea recorded.
 * @returns {string} The `/user` endpoint.
 */
function userEndpoint(
  forge: Exclude<Forge, "sourcehut" | "gitee" | "azure-devops" | "pushin" | "cursor-origin">,
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

/** Origin's 403 can be a team's IP allowlist turning the machine away, not the token. */
const ORIGIN_REFUSALS = [401];

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
    case "cursor-origin":
      return { authorization: `Bearer ${token}`, refusals: ORIGIN_REFUSALS };
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
  return compact({ ...info, ...compact(answerFacts(forge, answer)) });
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
 * Read the user out of a forge's answer: `login` on GitHub, Gitee and Pushin, `username` on GitLab,
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
