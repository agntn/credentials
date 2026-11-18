/**
 * `cf auth login` keeps its OAuth session in one file per profile, as JSON:
 *
 *   {"oauth_token": "...", "expiration_time": "...", "refresh_token": "...", "scopes": []}
 *
 * With `keyring_enabled` in cf's preferences, its default wherever a keyring answers, that
 * JSON sits in `config/<profile>.enc`, sealed with AES-256-GCM:
 *
 *   {"v": 1, "alg": "AES-256-GCM", "iv": "...", "tag": "...", "ciphertext": "..."}
 *
 * The key waits in the OS keyring under service `cloudflare`, with the profile as account, as
 * `{"v": 1, "key": "<base64 of 32 bytes>"}`. cf asks `secret-tool` on Linux and `security` on
 * macOS, so this does too. On Windows cf goes through a native binding, which is out of reach.
 */

import { execFile } from "node:child_process";
import { createDecipheriv } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parse } from "node:path";
import { compact, epoch, isRecord, nonEmptyString } from "./fields.ts";

/** The part of a cf OAuth session `resolve` hands out. */
export interface CfCredentials {
  readonly token: string;
  /** Milliseconds since the epoch. */
  readonly expiresAt?: number;
}

/** A session cf has and this package can't read. */
export interface CfUnreadable {
  /** Why, in words that quote no file and no key. */
  readonly unreadable: string;
  /** Whether cf sealed the file, so only a login without the keyring leaves a readable one. */
  readonly sealed: boolean;
  readonly cause?: unknown;
}

/** cf's sealed credentials file. */
interface Envelope {
  readonly iv: string;
  readonly tag: string;
  readonly ciphertext: string;
}

const KEYRING_SERVICE = "cloudflare";
const KEYRING_TIMEOUT_MS = 10_000;

/** The command that prints a profile's key, per platform, as cf itself runs it. */
const KEY_LOOKUPS: Partial<
  Record<NodeJS.Platform, (account: string) => readonly [string, ...string[]]>
> = {
  linux: (account) => ["secret-tool", "lookup", "service", KEYRING_SERVICE, "account", account],
  darwin: (account) => [
    "/usr/bin/security",
    "find-generic-password",
    "-s",
    KEYRING_SERVICE,
    "-a",
    account,
    "-w",
  ],
};

/**
 * Read the OAuth token out of cf's credentials file, sealed or not.
 * @param path - The file `cf auth whoami` names.
 * @returns {Promise<CfCredentials | CfUnreadable>} The token, or why there is none.
 */
export async function readCfCredentials(path: string): Promise<CfCredentials | CfUnreadable> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (cause) {
    return { ...unreadable("Cannot read the cf OAuth credentials file"), cause };
  }
  const stored = parseRecord(text);
  if (stored === undefined) return unreadable("Cannot read the cf OAuth credentials file");
  if (isEnvelope(stored)) return openEnvelope(stored, parse(path).name);
  return "ciphertext" in stored
    ? unreadable(
        "The cf OAuth credentials file is encrypted in a way this package cannot read",
        true,
      )
    : credentials(stored);
}

function unreadable(reason: string, sealed = false): CfUnreadable {
  return { unreadable: reason, sealed };
}

/* A SyntaxError quotes the start of its input, so it stops here and never becomes a cause. */
function parseRecord(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function isEnvelope(
  stored: Readonly<Record<string, unknown>>,
): stored is Record<string, unknown> & Envelope {
  return (
    stored.v === 1 &&
    stored.alg === "AES-256-GCM" &&
    [stored.iv, stored.tag, stored.ciphertext].every((part) => typeof part === "string")
  );
}

function credentials(stored: Readonly<Record<string, unknown>>): CfCredentials | CfUnreadable {
  const token = nonEmptyString(stored.oauth_token);
  if (token === undefined) return unreadable("The cf OAuth credentials file holds no token");
  return compact({ token, expiresAt: epoch(stored.expiration_time) });
}

/**
 * Open a sealed credentials file with the key from the keyring.
 * @param envelope - The file's content.
 * @param account - The profile, which names the key.
 * @returns {Promise<CfCredentials | CfUnreadable>} The token, or what the keyring withheld.
 */
async function openEnvelope(
  envelope: Readonly<Envelope>,
  account: string,
): Promise<CfCredentials | CfUnreadable> {
  const key = await keyringKey(account);
  if (key === undefined) {
    return unreadable(
      "The cf OAuth credentials file is encrypted, and its key could not be read from the OS keyring",
      true,
    );
  }
  const stored = parseRecord(decrypt(envelope, key));
  return stored === undefined
    ? unreadable("The key in the OS keyring does not open the cf OAuth credentials file", true)
    : credentials(stored);
}

/**
 * Ask the keyring for a profile's key.
 * @param account - The profile.
 * @returns {Promise<string | undefined>} The key in base64, if anything hands one over.
 */
async function keyringKey(account: string): Promise<string | undefined> {
  const lookup = KEY_LOOKUPS[process.platform];
  if (lookup === undefined) return undefined;
  const [file, ...args] = lookup(account);
  const output = await new Promise<string>((resolveOutput) => {
    execFile(file, args, { timeout: KEYRING_TIMEOUT_MS }, (error, stdout) => {
      resolveOutput(error ? "" : stdout);
    });
  });
  const entry = parseRecord(output.trim());
  return entry?.v === 1 ? nonEmptyString(entry.key) : undefined;
}

/**
 * Decrypt the envelope. A wrong key, a short tag and a damaged file all come back empty.
 * @param envelope - The file's content.
 * @param key - The key in base64.
 * @returns {string} The plain JSON, or an empty string.
 */
function decrypt(envelope: Readonly<Envelope>, key: string): string {
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      Buffer.from(key, "base64"),
      Buffer.from(envelope.iv, "base64"),
      { authTagLength: 16 },
    );
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    return decipher.update(envelope.ciphertext, "base64", "utf8") + decipher.final("utf8");
  } catch {
    return "";
  }
}
