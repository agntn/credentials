/**
 * `cafe auth login`, the GitCafe CLI, files each login under its API host in `cafe.json`:
 *
 *   {"version": 1, "hosts": {"git.cafe": {"apiUrl": "https://git.cafe/api", "backend": "native"}}}
 *
 * `backend` says where the token went. `native` is the system keyring, which only `cafe`
 * reads. `file-plaintext` is `credentials.json` beside it, keyed `https\0git.cafe\0\0cafe/api`.
 */

import { lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { epoch, isRecord, nonEmptyString } from "./fields.ts";
import { runCli } from "./forge.ts";

/** Where `cafe` sends everything without `CAFE_HOST`. */
export const CAFE_API = "https://git.cafe/api";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** A login `cafe.json` records. */
export interface CafeLogin {
  /** Host and port of the API, the key `cafe` files the login under. */
  readonly host: string;
  readonly apiUrl: string;
  readonly backend: "native" | "file-plaintext";
  readonly account?: string;
  /** Milliseconds since the epoch. */
  readonly expiresAt?: number;
}

/** A token from `credentials.json`. */
export interface CafeSavedToken {
  readonly token: string;
  /** Milliseconds since the epoch, 0 for a date `cafe` reads as passed. */
  readonly expiresAt?: number;
}

/**
 * Turn a URL or hostname into the API base `cafe` would use.
 * @param value - `CAFE_HOST`, a saved `apiUrl` or a caller's `baseURL`.
 * @returns {string | undefined} The API base, or undefined for anything but http and https.
 */
export function cafeApiUrl(value: string): string | undefined {
  const trimmed = value.trim();
  const bare = trimmed.split(":")[0] ?? trimmed;
  const withScheme = trimmed.includes("://")
    ? trimmed
    : `${LOOPBACK.has(bare) ? "http" : "https"}://${trimmed}`;
  const url = URL.parse(withScheme);
  if (url === null || !url.hostname || (url.protocol !== "https:" && url.protocol !== "http:")) {
    return undefined;
  }
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${path.endsWith("/api") ? path : `${path}/api`}`;
}

/**
 * Read the key a login is filed under in `cafe.json`.
 * @param apiUrl - An API base from `cafeApiUrl`.
 * @returns {string} Its host and port.
 */
export function cafeHost(apiUrl: string): string {
  return new URL(apiUrl).host;
}

/**
 * Find `cafe.json` like `cafe`: `CAFE_AUTH_FILE`, else `gitcafe/` under XDG, on every platform.
 * @returns {string} The file path.
 */
function cafeAuthFile(): string {
  return (
    process.env.CAFE_AUTH_FILE ||
    join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "gitcafe", "cafe.json")
  );
}

/**
 * List the logins `cafe.json` records, skipping any whose `apiUrl` isn't on its own key.
 * @returns {CafeLogin[]} One per host, in file order.
 */
export function cafeLogins(): CafeLogin[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(cafeAuthFile(), "utf-8"));
  } catch {
    return [];
  }
  const hosts = isRecord(parsed) ? parsed.hosts : undefined;
  if (!isRecord(hosts)) return [];
  return Object.entries(hosts).flatMap(([host, entry]) => {
    const login = isRecord(entry) ? cafeLogin(host, entry) : undefined;
    return login === undefined ? [] : [login];
  });
}

/**
 * Read one host's entry the way `cafe` does, `backend` required.
 * @param host - Its key.
 * @param entry - Its fields.
 * @returns {CafeLogin | undefined} The login, or undefined when `cafe` would skip it.
 */
function cafeLogin(host: string, entry: Readonly<Record<string, unknown>>): CafeLogin | undefined {
  const { backend } = entry;
  const saved = nonEmptyString(entry.apiUrl);
  const apiUrl = saved === undefined ? undefined : cafeApiUrl(saved);
  if (apiUrl === undefined || cafeHost(apiUrl) !== host) return undefined;
  if (backend !== "native" && backend !== "file-plaintext") return undefined;
  const login: CafeLogin = { host, apiUrl, backend };
  const account = nonEmptyString(entry.username);
  const expiresAt = epoch(entry.expiresAt);
  return {
    ...login,
    ...(account === undefined ? {} : { account }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
  };
}

/**
 * Pick the login `cafe` would use for an API base.
 * @param apiUrl - An API base from `cafeApiUrl`.
 * @returns {CafeLogin | undefined} The login, or undefined when that host has none.
 */
export function cafeLoginFor(apiUrl: string): CafeLogin | undefined {
  const host = cafeHost(apiUrl);
  return cafeLogins().find((login) => login.host === host);
}

/**
 * Read a `file-plaintext` login's token, from a file only its owner can read.
 * @param login - The login, from `cafeLogins`.
 * @param apiUrl - The API base asked for, scheme included.
 * @returns {CafeSavedToken | undefined} The token, or undefined for a keyring login or no entry.
 */
export function cafeSavedToken(login: CafeLogin, apiUrl: string): CafeSavedToken | undefined {
  if (login.backend !== "file-plaintext") return undefined;
  const credentials = savedCredentials();
  const key = credentialKey(apiUrl);
  const entry =
    credentials !== undefined && Object.hasOwn(credentials, key) ? credentials[key] : undefined;
  const token = nonEmptyString(entry?.token);
  if (entry === undefined || token === undefined) return undefined;
  const { expiresAt } = entry;
  return expiresAt === null ? { token } : { token, expiresAt: epoch(expiresAt) ?? 0 };
}

/** One entry of `credentials.json`, every field `cafe` requires. */
interface SavedEntry {
  readonly token: string;
  readonly username: string | null;
  readonly expiresAt: string | null;
}

/**
 * Read the plaintext file: `CAFE_CREDENTIAL_FILE`, else the one beside `cafe.json`.
 * @returns {Record<string, SavedEntry> | undefined} Its `credentials`, or undefined.
 */
function savedCredentials(): Record<string, SavedEntry> | undefined {
  const path =
    process.env.CAFE_CREDENTIAL_FILE || join(dirname(cafeAuthFile()), "credentials.json");
  const content = readPrivateFile(path);
  if (content === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(content);
    const credentials = isRecord(parsed) && parsed.version === 1 ? parsed.credentials : undefined;
    if (!isRecord(credentials)) return undefined;
    const entries = Object.entries(credentials);
    const valid = entries.filter((entry): entry is [string, SavedEntry] => isSavedEntry(entry[1]));
    return valid.length === entries.length ? Object.fromEntries(valid) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Check an entry against `cafe`'s schema. One bad entry makes `cafe` drop the whole file.
 * @param value - The entry.
 * @returns {value is SavedEntry} Whether `cafe` would read it.
 */
function isSavedEntry(value: unknown): value is SavedEntry {
  if (!isRecord(value) || typeof value.token !== "string") return false;
  const { username, expiresAt } = value;
  return (
    (username === null || typeof username === "string") &&
    (expiresAt === null || typeof expiresAt === "string")
  );
}

/**
 * Read a file only when `cafe` would: a regular file of this user that no one else can read.
 * @param path - The file.
 * @returns {string | undefined} Its content, or undefined when missing or exposed.
 */
function readPrivateFile(path: string): string | undefined {
  try {
    const stats = lstatSync(path);
    if (!stats.isFile() || (stats.mode & 0o077) !== 0) return undefined;
    if (process.getuid !== undefined && stats.uid !== process.getuid()) return undefined;
    return readFileSync(path, "utf-8");
  } catch {
    return undefined;
  }
}

/**
 * Build the key `cafe` files a token under in `credentials.json`.
 * @param apiUrl - The login's API base.
 * @returns {string} Protocol, host, an empty username and `cafe/api`, joined by NUL.
 */
function credentialKey(apiUrl: string): string {
  const url = new URL(apiUrl);
  const protocol = url.protocol === "http:" ? "http" : "https";
  return [protocol, url.host, "", "cafe/api"].join("\0");
}

/**
 * Ask `cafe`'s Git credential helper for the token, keyring logins included.
 * @param apiUrl - The API base whose login to read.
 * @returns {string | null} The token, or null without `cafe` or a live login for that host.
 */
export function cafeCliToken(apiUrl: string): string | null {
  const { hostname, host } = new URL(apiUrl);
  const loopback = LOOPBACK.has(hostname);
  const gitHost = loopback ? "localhost:3001" : host.replace(/^api\./, "");
  const args = ["auth", "http", "credential", "get", "--host", apiUrl];
  const request = `protocol=${loopback ? "http" : "https"}\nhost=${gitHost}\n\n`;
  const output = runCli("cafe", [...args, "--no-input", "--no-update-check"], request);
  const line = output?.split(/\r?\n/).find((entry) => entry.startsWith("password="));
  return line?.slice("password=".length) || null;
}
