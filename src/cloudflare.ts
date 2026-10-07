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
import type { CredentialSource } from "./core/types.ts";

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

interface CfSession {
  readonly accountIds: readonly string[];
  readonly token: string;
  readonly expiresAt?: number;
}

const SERVICE = "cloudflare";
const CF_OAUTH_SOURCE = "OAuth token from ";
const CF_TIMEOUT_MS = 30_000;
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
  return (
    nonEmpty(options?.accountId) ??
    envValue("AGNTN_CLOUDFLARE_ACCOUNT_ID") ??
    envValue("CLOUDFLARE_ACCOUNT_ID")
  );
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
  const status = parseJson(await cfWhoami(), "cf auth whoami did not print JSON");
  if (!isRecord(status) || status.authenticated !== true) {
    throw cfFailure("cf CLI is not logged in");
  }
  const stored = await readCfToken(status.authSource);
  const expiry =
    typeof stored.expiration_time === "string" ? Date.parse(stored.expiration_time) : Number.NaN;
  return {
    accountIds: accountIds(status.accounts),
    token: stored.oauth_token,
    ...(Number.isNaN(expiry) ? {} : { expiresAt: expiry }),
  };
}

/**
 * Run `cf auth whoami` without the env token, which cf would report instead of its OAuth session.
 * @returns {Promise<string>} The JSON status cf prints.
 */
async function cfWhoami(): Promise<string> {
  const env = { ...process.env };
  delete env.CLOUDFLARE_API_TOKEN;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
