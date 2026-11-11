/**
 * `origin`, the Cursor Origin CLI, saves its login for origin.cursor.com in `credentials.json`:
 *
 *   {"accessToken": "<JWT>", "refreshToken": "...", "authMethod": "login", "endpoint": "..."}
 *
 * On macOS it tries the keychain first and keeps this file only as a fallback. The access
 * token lives for minutes, and `origin auth token` refreshes it, so the file alone only
 * helps while that token is fresh.
 */

import { Buffer } from "node:buffer";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { isRecord, nonEmptyString } from "./fields.ts";

/** The instance `forges/cursor-origin` and the CLI's own login target. */
export const ORIGIN_HOST = "origin.cursor.com";

/** Where the CLI sends REST calls for origin.cursor.com. */
export const ORIGIN_API = "https://api.cursor.com/v1/origin";

/** Endpoints the CLI maps onto `ORIGIN_API`. */
const PRODUCTION_HOSTS = new Set([ORIGIN_HOST, "api.origin.cursor.com"]);

const AUTH_METHODS = new Set(["login", "api-key", "dev-login"]);

/** The login `origin auth login` saved for origin.cursor.com. */
export interface OriginLogin {
  readonly token: string;
  /** Milliseconds since the epoch, from the access token's `exp`. */
  readonly expiresAt?: number;
}

/**
 * Tell whether a caller's `baseURL` points at origin.cursor.com.
 * @param baseURL - What the caller sends the token to.
 * @returns {boolean} True for api.cursor.com, origin.cursor.com and its subdomains, over https.
 */
export function isOriginInstance(baseURL: string): boolean {
  const url = URL.parse(baseURL);
  if (url?.protocol !== "https:") return false;
  const host = url.hostname;
  return host === "api.cursor.com" || host === ORIGIN_HOST || host.endsWith(`.${ORIGIN_HOST}`);
}

/**
 * Where the CLI sends `CURSOR_AUTH_TOKEN`: the API behind `CURSOR_ORIGIN_ENDPOINT`.
 * @returns {string | undefined} The API base, or undefined for an endpoint `origin` won't trust.
 */
export function originApiBase(): string | undefined {
  const endpoint = process.env.CURSOR_ORIGIN_ENDPOINT?.trim();
  if (!endpoint) return ORIGIN_API;
  const url = URL.parse(endpoint);
  if (url === null || !isTrustedEndpoint(url.hostname, url.protocol)) return undefined;
  return PRODUCTION_HOSTS.has(url.hostname) ? ORIGIN_API : `${url.origin}/v1/origin`;
}

/** The Origin hosts `origin` hands `CURSOR_AUTH_TOKEN` to, subdomains included. */
const TRUSTED_ROOTS = [ORIGIN_HOST, "origin-staging.cursor.com", "origin-test.cursor.com"];

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Tell an endpoint `origin` takes the token to: an Origin host over https, or loopback.
 * @param hostname - The endpoint's host name.
 * @param protocol - Its scheme, with the colon.
 * @returns {boolean} Whether the CLI would send `CURSOR_AUTH_TOKEN` there.
 */
function isTrustedEndpoint(hostname: string, protocol: string): boolean {
  if (LOOPBACK.has(hostname)) return protocol === "https:" || protocol === "http:";
  if (protocol !== "https:") return false;
  return TRUSTED_ROOTS.some((root) => hostname === root || hostname.endsWith(`.${root}`));
}

/**
 * Find the config dir like `origin`: `~/.config/origin-cli` once it exists, else XDG.
 * @returns {string} The directory.
 */
function originConfigDir(): string {
  const legacy = join(homedir(), ".config", "origin-cli");
  const xdg = process.env.XDG_CONFIG_HOME;
  if (!xdg || !isAbsolute(xdg) || existsSync(legacy)) return legacy;
  return join(xdg, "origin-cli");
}

/**
 * Read the saved origin.cursor.com login, skipping a local dev server's.
 * @returns {OriginLogin | undefined} The access token and its expiry, or undefined.
 */
export function originLogin(): OriginLogin | undefined {
  let saved: unknown;
  try {
    saved = JSON.parse(readFileSync(join(originConfigDir(), "credentials.json"), "utf-8"));
  } catch {
    return undefined;
  }
  if (!isRecord(saved) || !isSavedLogin(saved)) return undefined;
  const token = nonEmptyString(saved.accessToken);
  if (token === undefined) return undefined;
  const expiresAt = jwtExpiry(token);
  return expiresAt === undefined ? { token } : { token, expiresAt };
}

/**
 * Check the fields the CLI requires, and that the login isn't for a loopback dev server.
 * @param saved - The parsed file.
 * @returns {boolean} Whether the CLI would read it as the origin.cursor.com login.
 */
function isSavedLogin(saved: Readonly<Record<string, unknown>>): boolean {
  const { refreshToken, authMethod, endpoint } = saved;
  if (typeof refreshToken !== "string" || typeof endpoint !== "string") return false;
  if (typeof authMethod !== "string" || !AUTH_METHODS.has(authMethod)) return false;
  return !LOOPBACK.has(URL.parse(endpoint)?.hostname ?? "");
}

/**
 * Read `exp` from a JWT without checking its signature.
 * @param token - The access token.
 * @returns {number | undefined} Milliseconds since the epoch, or undefined for a token without one.
 */
function jwtExpiry(token: string): number | undefined {
  const payload = token.split(".")[1];
  if (payload === undefined) return undefined;
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf-8"));
    const exp = isRecord(claims) ? claims.exp : undefined;
    return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}
