/**
 * `pun login`, the Pushin CLI, keeps one token per instance URL in `hosts.json`:
 *
 *   {"hosts": {"https://pushin.eu": {"token": "..."}}, "aliases": {}}
 *
 * The key is `PUSHIN_URL` as it was at login, and pun sends the token to that URL, trailing
 * slashes cut, plus `/api/v1`. `pun auth token` prints `PUSHIN_TOKEN` or this file and nothing
 * else, so the file is the whole CLI step.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isRecord, nonEmptyString } from "./fields.ts";
import { configDir } from "./forge.ts";

/** Where pun and `forges/pushin` go without `PUSHIN_URL`. */
export const PUSHIN_ORIGIN = "https://pushin.eu";

/** A token pun saved for one instance. */
export interface PunLogin {
  /** Scheme, host and port, which picks the login. */
  readonly origin: string;
  /** Where pun sends the token: the saved URL, trailing slashes cut. */
  readonly base: string;
  readonly token: string;
}

/**
 * Find `hosts.json` like pun: `PUN_CONFIG_DIR`, then XDG, or `%APPDATA%` on Windows.
 * @returns {string} The file path.
 */
function punConfigFile(): string {
  const dir =
    process.env.PUN_CONFIG_DIR ||
    (process.platform === "win32"
      ? join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "pun")
      : join(configDir(), "pun"));
  return join(dir, "hosts.json");
}

/**
 * Take the origin of an http or https URL.
 * @param url - A saved key or a caller's `baseURL`.
 * @returns {string | undefined} The origin, or undefined for anything pun can't send to.
 */
export function httpOrigin(url: string): string | undefined {
  const parsed = URL.parse(url);
  if (parsed?.protocol !== "https:" && parsed?.protocol !== "http:") return undefined;
  return parsed.origin;
}

/**
 * List the tokens pun saved, skipping keys that aren't http or https URLs.
 * @returns {PunLogin[]} One per instance with a token, in file order.
 */
export function punLogins(): PunLogin[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(punConfigFile(), "utf-8"));
  } catch {
    return [];
  }
  const hosts = isRecord(parsed) ? parsed.hosts : undefined;
  if (!isRecord(hosts)) return [];
  return Object.entries(hosts).flatMap(([key, entry]): PunLogin[] => {
    const token = isRecord(entry) ? nonEmptyString(entry.token) : undefined;
    const origin = httpOrigin(key);
    if (token === undefined || origin === undefined) return [];
    return [{ origin, base: key.replace(/\/+$/, ""), token }];
  });
}

/**
 * Pick the first login saved for an origin.
 * @param logins - What `punLogins` found.
 * @param origin - The instance the token will go to.
 * @returns {PunLogin | undefined} The login, or undefined when that instance has none.
 */
export function punLoginFor(logins: readonly PunLogin[], origin: string): PunLogin | undefined {
  return logins.find((login) => login.origin === origin);
}
