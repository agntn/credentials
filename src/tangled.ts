/**
 * Tangled logins: an AT Protocol identifier and app password, the `app_password` auth of
 * `forges/tangled`. No token anywhere.
 *
 * TANGLED_HANDLE and TANGLED_PASSWORD are what tangled-mcp reads, TANGLED_PDS_URL is in its
 * `.env.example`. Tangled's CLIs keep their sessions in the keyring, so the chain ends here.
 */

import { compact, nonEmptyString } from "./core/fields.ts";
import type { CredentialInfo, CredentialSource, ListOptions } from "./core/types.ts";
import { field, probe } from "./core/verify.ts";

/** An AT Protocol login and the step of the chain that found it. */
export interface TangledCredential {
  /** A handle or a DID. */
  readonly identifier: string;
  /** An app password. */
  readonly password: string;
  readonly source: CredentialSource;
  /** Left out when unset, and the client finds the PDS from the identifier. */
  readonly pds?: string;
}

export interface TangledOptions {
  /** With `password`, wins over the environment. Half a pair finds nothing. */
  readonly identifier?: string;
  readonly password?: string;
  /** Wins over TANGLED_PDS_URL. */
  readonly pds?: string;
}

interface Login {
  readonly identifier: string | undefined;
  readonly password: string | undefined;
}

const SERVICE = "tangled";
const HANDLE = "TANGLED_HANDLE";
const PASSWORD = "TANGLED_PASSWORD";
const PDS = "TANGLED_PDS_URL";
const SESSION_TIMEOUT_MS = 10_000;

/**
 * Find a Tangled login: the explicit pair, then TANGLED_HANDLE with TANGLED_PASSWORD.
 * @param options - Explicit identifier, app password and PDS.
 * @returns {TangledCredential | null} The login, or null, also for a non-http(s) PDS.
 */
export function resolve(options?: TangledOptions): TangledCredential | null {
  const login = givenLogin(options);
  if (login === null) return null;
  const setting = nonEmptyString(options?.pds) ?? envValue(PDS);
  if (setting === undefined) return login;
  const pds = pdsBase(setting);
  return pds === undefined ? null : { ...login, pds };
}

/**
 * The caller's pair, or the environment's when the caller passes none.
 * @param options - The caller's options.
 * @returns {TangledCredential | null} The login without its PDS, or null.
 */
function givenLogin(options?: TangledOptions): TangledCredential | null {
  if (options?.identifier === undefined && options?.password === undefined) {
    return complete({ identifier: envValue(HANDLE), password: envValue(PASSWORD) }, "env");
  }
  return complete({ identifier: options.identifier, password: options.password }, "explicit");
}

/**
 * Both halves or nothing.
 * @param login - Identifier and password, either maybe missing.
 * @param source - Where they came from.
 * @returns {TangledCredential | null} The login, or null.
 */
function complete(login: Login, source: CredentialSource): TangledCredential | null {
  const identifier = nonEmptyString(login.identifier);
  const password = nonEmptyString(login.password);
  return identifier === undefined || password === undefined
    ? null
    : { identifier, password, source };
}

function envValue(name: string): string | undefined {
  return nonEmptyString(process.env[name]);
}

/**
 * Describe the login in the environment, without its password. `verify` needs TANGLED_PDS_URL.
 * @param options - Whether to log in at the PDS.
 * @returns {Promise<CredentialInfo[]>} One entry when TANGLED_PASSWORD is set, else none.
 */
export async function list(options?: ListOptions): Promise<CredentialInfo[]> {
  const password = envValue(PASSWORD);
  if (password === undefined) return [];
  const identifier = envValue(HANDLE);
  const setting = envValue(PDS);
  const pds = pdsBase(setting);
  const info = compact<CredentialInfo>({
    service: SERVICE,
    host: pds === undefined ? "any" : new URL(pds).host,
    source: "env",
    origin: PASSWORD,
    active: identifier !== undefined && (setting === undefined || pds !== undefined),
    state: "unchecked",
    account: identifier,
    note: envNote(identifier, setting),
  });
  if (options?.verify !== true || identifier === undefined || pds === undefined) return [info];
  return [await verified(info, { identifier, password, pds })];
}

/**
 * TANGLED_PDS_URL as the base for XRPC paths.
 * @param url - The variable, if set.
 * @returns {string | undefined} The URL without a trailing slash, or undefined unless http(s).
 */
function pdsBase(url: string | undefined): string | undefined {
  if (url === undefined || !URL.canParse(url)) return undefined;
  const { protocol } = new URL(url);
  return protocol === "https:" || protocol === "http:" ? url.replace(/\/+$/, "") : undefined;
}

/**
 * Why the login goes unused or unchecked.
 * @param identifier - TANGLED_HANDLE, if set.
 * @param setting - TANGLED_PDS_URL, if set.
 * @returns {string | undefined} The note, or undefined.
 */
function envNote(identifier: string | undefined, setting: string | undefined): string | undefined {
  if (identifier === undefined) {
    return `${PASSWORD} goes out with ${HANDLE}, which isn't set, so resolve skips it`;
  }
  if (setting === undefined) {
    return `${PDS} isn't set, so the PDS comes from the handle and the password is never sent anywhere to check`;
  }
  return pdsBase(setting) === undefined
    ? `${PDS} isn't an http(s) URL, so resolve skips this login`
    : undefined;
}

/**
 * Log in at the PDS, log out again, and keep the verdict.
 * @param info - The entry.
 * @param login - Identifier, app password and PDS base.
 * @returns {Promise<CredentialInfo>} The entry with its state and handle.
 */
async function verified(
  info: CredentialInfo,
  login: Readonly<{ identifier: string; password: string; pds: string }>,
): Promise<CredentialInfo> {
  const { identifier, password, pds } = login;
  const answer = await probe(`${pds}/xrpc/com.atproto.server.createSession`, {
    body: JSON.stringify({ identifier, password }),
  });
  if (answer.state !== "valid") return { ...info, state: answer.state, note: answer.note };
  await endSession(pds, field(answer.body, "refreshJwt"));
  return { ...info, state: "valid", account: field(answer.body, "handle") ?? identifier };
}

/**
 * Close the session a check opened. A failure here can't change the verdict.
 * @param pds - The PDS base.
 * @param refreshJwt - The token deleteSession wants, not the access one.
 * @returns {Promise<void>} Once the PDS answers or the request fails.
 */
async function endSession(pds: string, refreshJwt: string | undefined): Promise<void> {
  if (refreshJwt === undefined) return;
  await fetch(`${pds}/xrpc/com.atproto.server.deleteSession`, {
    method: "POST",
    headers: { Authorization: `Bearer ${refreshJwt}`, "User-Agent": "@agntn/credentials" },
    redirect: "error",
    signal: AbortSignal.timeout(SESSION_TIMEOUT_MS),
  }).catch(() => undefined);
}
