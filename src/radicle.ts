/**
 * Radicle logins: the Ed25519 key `rad auth` keeps under the Radicle home. No token
 * anywhere, and no service to ask: the key signs on this machine.
 */

import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createBase58 } from "@agntn/encodings/base58";
import { compact, isRecord, nonEmptyString } from "./core/fields.ts";
import type { CredentialInfo, CredentialSource, ListOptions } from "./core/types.ts";

/** A Radicle identity and the key behind it, never the key itself. */
export interface RadicleCredential {
  /** The Radicle home the key came from. */
  readonly home: string;
  /** `did:key:` of the public key, the same as `rad self --did`. */
  readonly did: string;
  /** The node alias from `config.json`. */
  readonly alias: string;
  /** The secret key file, in OpenSSH format. */
  readonly keyPath: string;
  /** Whether the key needs a passphrase. `rad` then takes RAD_PASSPHRASE or ssh-agent. */
  readonly encrypted: boolean;
  /** RAD_PASSPHRASE, only for an encrypted key. */
  readonly passphrase?: string;
  readonly source: CredentialSource;
}

export interface RadicleOptions {
  /** Wins over RAD_HOME and `~/.radicle`. */
  readonly home?: string;
}

interface Home {
  readonly path: string;
  readonly source: CredentialSource;
  readonly origin: string;
}

interface Key {
  readonly did: string;
  readonly alias: string;
  readonly encrypted: boolean;
}

const SERVICE = "radicle";
const HOME = "RAD_HOME";
const PASSPHRASE = "RAD_PASSPHRASE";
const KEY_FILE = "rad keys/radicle";
const SSH_ED25519 = "ssh-ed25519";
const OPENSSH_MAGIC = "openssh-key-v1\0";
const OPENSSH_PEM =
  /-----BEGIN OPENSSH PRIVATE KEY-----([\s\S]*?)-----END OPENSSH PRIVATE KEY-----/;
/** The multicodec prefix of an Ed25519 public key, as `did:key` writes it. */
const ED25519_MULTICODEC = [0xed, 0x01];
const base58 = createBase58("bitcoin");
const WINDOWS = process.platform === "win32";
/** What `Alias::from_str` takes: no whitespace, no control characters, at most 32 bytes. */
const ALIAS = /^[^\p{Cc}\s]+$/u;
const MAX_ALIAS_BYTES = 32;

/**
 * Find the Radicle key: the explicit home, then RAD_HOME, then `~/.radicle`, as `rad` does.
 * @param options - An explicit Radicle home.
 * @returns {RadicleCredential | null} The identity, or null wherever `rad` couldn't load it.
 */
export function resolve(options?: RadicleOptions): RadicleCredential | null {
  const home = radicleHome(options?.home);
  const key = home === undefined ? undefined : readKey(home.path);
  if (home === undefined || key === undefined) return null;
  const passphrase = key.encrypted ? nonEmptyString(process.env[PASSPHRASE]) : undefined;
  return compact<RadicleCredential>({
    home: home.path,
    did: key.did,
    alias: key.alias,
    keyPath: join(home.path, "keys", "radicle"),
    encrypted: key.encrypted,
    passphrase,
    source: home.source,
  });
}

/**
 * Describe the Radicle key, without it. There is nothing to verify against, so it stays unchecked.
 * @param _options - Accepted like every other `list`; `verify` has no service to ask.
 * @returns {Promise<CredentialInfo[]>} One entry when the home holds a key, else none.
 */
export async function list(_options?: ListOptions): Promise<CredentialInfo[]> {
  const home = radicleHome(undefined);
  const key = home === undefined ? undefined : readKey(home.path);
  if (home === undefined || key === undefined) return [];
  return [
    compact<CredentialInfo>({
      service: SERVICE,
      host: "any",
      source: home.source,
      origin: home.origin,
      active: true,
      state: "unchecked",
      account: key.alias,
      note: listNote(key),
    }),
  ];
}

/**
 * Pick the Radicle home like `rad`: RAD_HOME as is, else `.radicle` under HOME.
 * @param explicit - The caller's home, if any.
 * @returns {Home | undefined} The path and the step that named it, or undefined where `rad`
 * gives up too: an empty RAD_HOME, or no HOME to put `.radicle` in.
 */
function radicleHome(explicit: string | undefined): Home | undefined {
  const given = nonEmptyString(explicit);
  if (given !== undefined) return { path: given, source: "explicit", origin: "home" };
  const variable = process.env[HOME];
  if (variable !== undefined) {
    return variable === "" ? undefined : { path: variable, source: "env", origin: HOME };
  }
  const base = process.env.HOME ?? (WINDOWS ? process.env.USERPROFILE : undefined);
  return base === undefined
    ? undefined
    : { path: join(base, ".radicle"), source: "config", origin: KEY_FILE };
}

/**
 * Read the public key into a DID, the alias, and whether the secret key is encrypted.
 * @param home - The Radicle home.
 * @returns {Key | undefined} The key, or undefined when a file is missing, broken or not Ed25519.
 */
function readKey(home: string): Key | undefined {
  const keys = join(home, "keys");
  const publicKey = ed25519PublicKey(readText(join(keys, "radicle.pub")));
  const encrypted = isEncrypted(readText(join(keys, "radicle")));
  const alias = readAlias(home);
  if (publicKey === undefined || encrypted === undefined || alias === undefined) return undefined;
  const did = `did:key:z${base58.encode(Uint8Array.from([...ED25519_MULTICODEC, ...publicKey]))}`;
  return { did, alias, encrypted };
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Take the 32 key bytes out of an OpenSSH `ssh-ed25519` line.
 * @param line - `radicle.pub`, if it could be read.
 * @returns {readonly number[] | undefined} The key, or undefined for another key type or shape.
 */
function ed25519PublicKey(line: string | undefined): readonly number[] | undefined {
  const [type, encoded = ""] = line?.trim().split(/\s+/) ?? [];
  if (type !== SSH_ED25519) return undefined;
  const [name, key] = sshStrings([...Buffer.from(encoded, "base64")], 2) ?? [[], []];
  return ascii(name) === SSH_ED25519 && key?.length === 32 ? key : undefined;
}

/**
 * Tell an encrypted OpenSSH secret key from a plain one by its cipher name.
 * @param pem - `keys/radicle`, if it could be read.
 * @returns {boolean | undefined} Whether it is encrypted, or undefined when it isn't OpenSSH.
 */
function isEncrypted(pem: string | undefined): boolean | undefined {
  const body = pem === undefined ? undefined : OPENSSH_PEM.exec(pem)?.[1];
  if (body === undefined) return undefined;
  const bytes = Buffer.from(body.replaceAll(/\s+/g, ""), "base64");
  if (bytes.toString("latin1", 0, OPENSSH_MAGIC.length) !== OPENSSH_MAGIC) return undefined;
  const [cipher] = sshStrings([...bytes.subarray(OPENSSH_MAGIC.length)], 1) ?? [];
  return cipher === undefined ? undefined : ascii(cipher) !== "none";
}

/**
 * Read length-prefixed SSH strings off the front of the wire bytes.
 * @param bytes - The bytes.
 * @param count - How many strings to read.
 * @returns {number[][] | undefined} The strings, or undefined when the bytes run out first.
 */
function sshStrings(bytes: readonly number[], count: number): number[][] | undefined {
  const strings: number[][] = [];
  let offset = 0;
  while (strings.length < count) {
    const start = offset + 4;
    const length = bytes.slice(offset, start).reduce((value, byte) => value * 256 + byte, 0);
    if (start > bytes.length || start + length > bytes.length) return undefined;
    strings.push(bytes.slice(start, start + length));
    offset = start + length;
  }
  return strings;
}

/**
 * Read an SSH name, which is plain ASCII.
 * @param bytes - The string's bytes.
 * @returns {string} The name.
 */
function ascii(bytes: readonly number[] = []): string {
  return String.fromCodePoint(...bytes);
}

/**
 * Read the node alias `rad self --alias` prints. `rad` won't load a profile without it.
 * @param home - The Radicle home.
 * @returns {string | undefined} The alias, or undefined without a readable config.
 */
function readAlias(home: string): string | undefined {
  let config: unknown;
  try {
    config = JSON.parse(readText(join(home, "config.json")) ?? "null");
  } catch {
    return undefined;
  }
  const node = isRecord(config) ? config.node : undefined;
  const alias = isRecord(node) ? node.alias : undefined;
  return typeof alias === "string" &&
    ALIAS.test(alias) &&
    Buffer.byteLength(alias) <= MAX_ALIAS_BYTES
    ? alias
    : undefined;
}

/**
 * Say what signing with the key takes.
 * @param key - The key read from the home.
 * @returns {string} The note.
 */
function listNote(key: Key): string {
  const unlock = !key.encrypted
    ? "no passphrase"
    : nonEmptyString(process.env[PASSPHRASE]) === undefined
      ? "encrypted, so rad wants it in ssh-agent"
      : `encrypted, unlocked by ${PASSPHRASE}`;
  return `${key.did}, ${unlock}. It signs here and never leaves the machine`;
}
