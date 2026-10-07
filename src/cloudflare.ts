/**
 * Cloudflare API credentials: a bearer token and the account it acts on.
 *
 * The token comes from the caller, then `CLOUDFLARE_API_TOKEN`, then the cf CLI's
 * OAuth session. The account comes from the caller, then `AGNTN_CLOUDFLARE_ACCOUNT_ID`,
 * then `CLOUDFLARE_ACCOUNT_ID`, then the cf session when it reaches exactly one account.
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { CredentialsError } from "./core/errors.ts";
import { compact, epoch, isRecord, nonEmptyString } from "./core/fields.ts";
import { withoutVariables } from "./core/forge.ts";
import type { CredentialInfo, CredentialSource, ListOptions } from "./core/types.ts";
import { type Probe, probe } from "./core/verify.ts";

export interface CloudflareCredential {
  readonly token: string;
  readonly accountId: string;
  /** Where the token came from; the account may come from another step. */
  readonly source: CredentialSource;
  /** Milliseconds since the epoch, for a cf OAuth token that records one. */
  readonly expiresAt?: number;
}

export interface CloudflareOptions {
  /** Wins over the environment and cf. */
  readonly token?: string;
  /** Wins over both account variables and the cf session. */
  readonly accountId?: string;
  /**
   * Ask cf again even though the cached OAuth token has not expired yet,
   * for a caller whose request was just refused with 401.
   */
  readonly refresh?: boolean;
}

/** An account id and the setting it came from. */
interface AccountSetting {
  readonly id: string;
  readonly origin: string;
}

interface CfSession {
  readonly accountIds: readonly string[];
  readonly token: string;
  readonly expiresAt?: number;
}

const SERVICE = "cloudflare";
const CF_OAUTH_SOURCE = "OAuth token from ";
const CF_TIMEOUT_MS = 30_000;
/** `tokens/verify` answers a malformed token with 400, not 401. */
const TOKEN_REFUSALS = [400, 401, 403];
/** A token this close to expiry is fetched again, so it outlives the request it is for. */
const EXPIRY_MARGIN_MS = 60_000;
const SETUP_HINT =
  "Set CLOUDFLARE_API_TOKEN, or run `cf auth login` to use the cf CLI's OAuth session";

let cfSession: CfSession | undefined;
let cfSessionPromise: Promise<CfSession> | undefined;

/**
 * Resolve the token and account for the next Cloudflare API request.
 *
 * A token from cf is fetched again once it expires, so keep the result for one
 * request, not for the life of a client.
 * @param options - Explicit token and account, and whether to bypass the cf cache.
 * @returns {Promise<CloudflareCredential>} Credentials valid for the next request.
 * @throws {CredentialsError} When no token or no single account can be found.
 */
export async function resolve(options?: CloudflareOptions): Promise<CloudflareCredential> {
  const accountId = configuredAccount(options);
  const given = givenToken(options);
  if (given !== undefined) {
    if (accountId === undefined) {
      throw missingAccount(
        `${given.source === "env" ? "CLOUDFLARE_API_TOKEN" : "the token"} needs an account`,
      );
    }
    return { ...given, accountId };
  }

  const session = await getCfSession(options?.refresh === true);
  return {
    token: session.token,
    accountId: accountId ?? onlyAccount(session.accountIds),
    source: "cli",
    ...(session.expiresAt === undefined ? {} : { expiresAt: session.expiresAt }),
  };
}

function configuredAccount(options?: CloudflareOptions): string | undefined {
  return accountSetting(options)?.id;
}

/**
 * Find the account id the caller or the environment sets, and where it came from.
 * @param options - The caller's options.
 * @returns {{ id: string; origin: string } | undefined} The id and its origin, or undefined.
 */
function accountSetting(options?: CloudflareOptions): AccountSetting | undefined {
  const explicit = nonEmpty(options?.accountId);
  if (explicit !== undefined) return { id: explicit, origin: "accountId" };
  for (const name of ["AGNTN_CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_ACCOUNT_ID"]) {
    const id = envValue(name);
    if (id !== undefined) return { id, origin: name };
  }
  return undefined;
}

/**
 * Take the token the caller or the environment hands over, before cf is asked.
 * @param options - The caller's options.
 * @returns {{ token: string; source: "explicit" | "env" } | undefined} The token and its source, or undefined.
 */
function givenToken(
  options?: CloudflareOptions,
): { token: string; source: "explicit" | "env" } | undefined {
  const explicit = nonEmpty(options?.token);
  if (explicit !== undefined) return { token: explicit, source: "explicit" };
  const fromEnv = envValue("CLOUDFLARE_API_TOKEN");
  return fromEnv === undefined ? undefined : { token: fromEnv, source: "env" };
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === "" ? undefined : value;
}

function envValue(name: string): string | undefined {
  return nonEmpty(process.env[name]);
}

function getCfSession(refresh: boolean): Promise<CfSession> {
  const cached = cfSession;
  if (
    !refresh &&
    cached?.expiresAt !== undefined &&
    Date.now() < cached.expiresAt - EXPIRY_MARGIN_MS
  ) {
    return Promise.resolve(cached);
  }
  cfSessionPromise ??= loadCfSession()
    .then((session) => {
      cfSession = session;
      return session;
    })
    .finally(() => {
      cfSessionPromise = undefined;
    });
  return cfSessionPromise;
}

/**
 * Ask cf for its OAuth session.
 *
 * `cf auth whoami` refreshes an expired access token before it reports, so the
 * credentials file it names holds a token that was valid at that moment. cf has
 * no command that prints the token itself.
 * @returns {Promise<CfSession>} The token, its expiry and the accounts it reaches.
 */
async function loadCfSession(): Promise<CfSession> {
  const status = await cfStatus();
  const stored = await readCfToken(status.authSource);
  const expiresAt = epoch(stored.expiration_time);
  return {
    accountIds: accountIds(status.accounts),
    token: stored.oauth_token,
    ...(expiresAt === undefined ? {} : { expiresAt }),
  };
}

/**
 * Read cf's status for a logged in session.
 * @returns {Promise<Record<string, unknown>>} The status cf printed.
 * @throws {CredentialsError} When cf is missing, fails or is not logged in.
 */
async function cfStatus(): Promise<Record<string, unknown>> {
  const status = parseJson(await cfWhoami(), "cf auth whoami did not print JSON");
  if (!isRecord(status) || status.authenticated !== true) {
    throw cfFailure("cf CLI is not logged in");
  }
  return status;
}

/**
 * Run `cf auth whoami` without the env token, which cf would report instead of its OAuth session.
 * @returns {Promise<string>} The JSON status cf prints.
 */
async function cfWhoami(): Promise<string> {
  const env = withoutVariables(["CLOUDFLARE_API_TOKEN"]);
  try {
    return await new Promise((resolveOutput, reject) => {
      execFile("cf", ["auth", "whoami"], { env, timeout: CF_TIMEOUT_MS }, (error, stdout) => {
        if (error) reject(error);
        else resolveOutput(stdout);
      });
    });
  } catch (error) {
    const missing = isRecord(error) && error.code === "ENOENT";
    throw cfFailure(missing ? "cf CLI not found" : "cf auth whoami failed", error);
  }
}

/**
 * Read the OAuth token cf keeps in the file its status names.
 * @param source - The `authSource` line from `cf auth whoami`.
 * @returns {Promise<Record<string, unknown>>} The stored credentials with a token.
 */
async function readCfToken(
  source: unknown,
): Promise<Record<string, unknown> & { oauth_token: string }> {
  if (typeof source !== "string" || !source.startsWith(CF_OAUTH_SOURCE)) {
    throw cfFailure("cf CLI reports no OAuth session");
  }
  let text: string;
  try {
    text = await readFile(source.slice(CF_OAUTH_SOURCE.length), "utf8");
  } catch (error) {
    throw cfFailure("Cannot read the cf OAuth credentials file", error);
  }
  // An OS keyring keeps the file encrypted, and only cf can read it then.
  const stored = parseJson(text, "Cannot read the cf OAuth credentials file");
  if (!isRecord(stored) || typeof stored.oauth_token !== "string" || stored.oauth_token === "") {
    throw cfFailure("The cf OAuth credentials file holds no token");
  }
  return stored as Record<string, unknown> & { oauth_token: string };
}

function accountIds(accounts: unknown): string[] {
  if (!Array.isArray(accounts)) return [];
  return accounts.flatMap((account: unknown) =>
    isRecord(account) && typeof account.id === "string" ? [account.id] : [],
  );
}

function onlyAccount(ids: readonly string[]): string {
  if (ids.length === 1) return ids[0]!;
  throw missingAccount(
    ids.length === 0
      ? "the cf OAuth session lists no accounts"
      : `the cf OAuth session can reach ${ids.length} accounts`,
  );
}

function missingAccount(reason: string): CredentialsError {
  return new CredentialsError(
    SERVICE,
    `Set AGNTN_CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_ACCOUNT_ID: ${reason}`,
  );
}

function cfFailure(message: string, cause?: unknown): CredentialsError {
  return new CredentialsError(
    SERVICE,
    `${message}. ${SETUP_HINT}`,
    cause === undefined ? {} : { cause },
  );
}

/* The SyntaxError quotes the start of its input, so it never becomes a cause: the text reaches the model. */
function parseJson(text: string, failure: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw cfFailure(failure);
  }
}

const API_HOST = "api.cloudflare.com";
const API_BASE = `https://${API_HOST}/client/v4`;

/**
 * Describe every Cloudflare credential this machine holds, without the tokens.
 *
 * Lists `CLOUDFLARE_API_TOKEN` and the cf OAuth session, and names the account
 * `resolve` would act on for each. Running cf reaches the network, so the session's
 * state comes from cf whether or not `verify` is on. `verify` checks the env token
 * against `/user/tokens/verify`.
 * @param options - Whether to ask Cloudflare about the env token.
 * @returns {Promise<CredentialInfo[]>} The env token first, then the cf session.
 */
export async function list(options?: ListOptions): Promise<CredentialInfo[]> {
  const account = accountSetting();
  const envToken = envValue("CLOUDFLARE_API_TOKEN");
  const [fromEnv, session] = await Promise.all([
    envToken === undefined ? undefined : envEntry(envToken, account, options?.verify === true),
    sessionEntry(account, envToken === undefined),
  ]);
  return [fromEnv, session].filter((entry) => entry !== undefined);
}

/**
 * Describe `CLOUDFLARE_API_TOKEN`, asking Cloudflare about it when told to.
 * @param token - The env token, which never leaves this function except toward Cloudflare.
 * @param account - The configured account, if any.
 * @param verify - Whether to ask Cloudflare.
 * @returns {Promise<CredentialInfo>} The entry.
 */
async function envEntry(
  token: string,
  account: AccountSetting | undefined,
  verify: boolean,
): Promise<CredentialInfo> {
  const base = compact<CredentialInfo>({
    service: SERVICE,
    host: API_HOST,
    source: "env",
    origin: "CLOUDFLARE_API_TOKEN",
    active: true,
    state: "unchecked",
    accountId: account?.id,
    accountIdOrigin: account?.origin,
    note: account === undefined ? "no account id is set, so resolve refuses this token" : undefined,
  });
  if (!verify) return base;
  let answer = await probe(`${API_BASE}/user/tokens/verify`, `Bearer ${token}`, TOKEN_REFUSALS);
  // An account-owned token is unknown to the user endpoint.
  if (answer.state === "rejected" && account !== undefined) {
    answer = await probe(
      `${API_BASE}/accounts/${encodeURIComponent(account.id)}/tokens/verify`,
      `Bearer ${token}`,
      TOKEN_REFUSALS,
    );
  }
  return compact({ ...base, ...tokenFacts(answer) });
}

/**
 * Read the token status and expiry out of a `tokens/verify` answer.
 * @param answer - The probe result.
 * @returns {Partial<CredentialInfo>} The fields to merge into the entry.
 */
function tokenFacts(answer: Probe): Partial<CredentialInfo> {
  if (answer.state !== "valid") return { state: answer.state, note: answer.note };
  const result = isRecord(answer.body) && isRecord(answer.body.result) ? answer.body.result : {};
  const status = typeof result.status === "string" ? result.status : "unknown";
  return {
    state: TOKEN_STATES[status] ?? "rejected",
    note: status === "active" ? undefined : `token status ${status}`,
    expiresAt: epoch(result.expires_on),
  };
}

/** What each `tokens/verify` status means; anything else counts as refused. */
const TOKEN_STATES: Readonly<Record<string, CredentialInfo["state"]>> = {
  active: "valid",
  expired: "expired",
};

/**
 * Describe the cf OAuth session, or nothing when cf has none.
 * @param account - The configured account, if any.
 * @param active - Whether no env token wins over the session.
 * @returns {Promise<CredentialInfo | undefined>} The entry, or undefined without a session.
 */
async function sessionEntry(
  account: AccountSetting | undefined,
  active: boolean,
): Promise<CredentialInfo | undefined> {
  let status: Record<string, unknown>;
  try {
    status = await cfStatus();
  } catch {
    return undefined;
  }
  const ids = accountIds(status.accounts);
  const expiresAt = epoch(status.expiresAt);
  const target = account ?? (ids.length === 1 ? { id: ids[0]!, origin: "cf session" } : undefined);
  return compact<CredentialInfo>({
    service: SERVICE,
    host: API_HOST,
    source: "cli",
    origin: "cf",
    active,
    state: sessionState(status.tokenValid, expiresAt),
    account: nonEmptyString(status.email),
    accountId: target?.id,
    accountIdOrigin: target?.origin,
    scopes: strings(status.scopes),
    expiresAt,
    note:
      target === undefined
        ? `the session reaches ${ids.length} accounts and none is chosen`
        : undefined,
  });
}

/**
 * Read a list of strings.
 * @param value - Anything cf printed.
 * @returns {string[] | undefined} The strings in it, or undefined when it isn't a list.
 */
function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : undefined;
}

/**
 * Judge the cf session from what cf reported.
 * @param tokenValid - cf's own verdict on its token.
 * @param expiresAt - The token's expiry, if cf recorded one.
 * @returns {CredentialInfo["state"]} Expired, valid or rejected.
 */
function sessionState(tokenValid: unknown, expiresAt: number | undefined): CredentialInfo["state"] {
  if (expiresAt !== undefined && expiresAt <= Date.now()) return "expired";
  return tokenValid === true ? "valid" : "rejected";
}
