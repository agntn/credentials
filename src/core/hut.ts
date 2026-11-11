/**
 * hut, the Sourcehut CLI, keeps its logins in `hut/config` under the user config dir:
 *
 *   instance "sr.ht" {
 *     origin "sr.ht"
 *     access-token "<token>"
 *     # or: access-token-cmd pass show srht
 *     meta {
 *       origin "https://meta.sr.ht"
 *     }
 *   }
 *
 * The file is scfg, not YAML, and hut has no command that prints a token, so the file is
 * the only step after the environment.
 */

import { execFileSync } from "node:child_process";

const COMMAND_TIMEOUT_MS = 5000;

/** One `instance` block, as hut reads it. */
export interface HutInstance {
  readonly name: string;
  /** The instance's common domain, such as `sr.ht`. */
  readonly origin: string;
  /** The `access-token` value. */
  readonly token?: string;
  /** The `access-token-cmd` words, command first. */
  readonly command?: readonly string[];
  /** Origins set per service, such as the `origin` inside a `meta` block, as written. */
  readonly serviceOrigins: Readonly<Record<string, string>>;
}

interface Directive {
  readonly name: string;
  readonly params: readonly string[];
  readonly children: readonly Directive[];
}

/**
 * Read every instance from the text of hut's config file.
 * @param content - The file at `hutConfigFile()`.
 * @returns {HutInstance[]} The instances in file order.
 */
export function hutInstances(content: string): HutInstance[] {
  return parseScfg(content)
    .filter((directive) => directive.name === "instance" && directive.params[0] !== undefined)
    .map(instanceOf);
}

/**
 * Pick the instance whose token belongs to a host: the instance's domain, a subdomain of
 * it, or a host one of its services is set to. hut also matches a parent domain, but it
 * only picks an instance with that. The caller sends the token to this host.
 * @param instances - What `hutInstances` read.
 * @param hostname - The host asked about, such as `git.sr.ht`.
 * @returns {HutInstance | undefined} The first instance that matches.
 */
export function hutInstanceFor(
  instances: readonly HutInstance[],
  hostname: string,
): HutInstance | undefined {
  return instances.find(
    (instance) =>
      hostname === instance.origin ||
      hostname.endsWith(`.${instance.origin}`) ||
      Object.values(instance.serviceOrigins).some((origin) => hostOf(origin) === hostname),
  );
}

/**
 * Take an instance's token, running `access-token-cmd` the way hut does: the first word it prints.
 * @param instance - The instance.
 * @returns {string | null} The token, or null when there is none or the command fails.
 */
export function hutToken(instance: HutInstance): string | null {
  if (instance.token !== undefined) return instance.token || null;
  const [command, ...args] = instance.command ?? [];
  if (command === undefined) return null;
  try {
    const output = execFileSync(command, args, {
      encoding: "utf-8",
      timeout: COMMAND_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return output.trim().split(/\s+/, 1)[0] || null;
  } catch {
    return null;
  }
}

/**
 * The meta.sr.ht GraphQL endpoint of an instance, which names the token's user.
 * @param instance - The instance.
 * @returns {string} Its `/query` URL.
 */
export function hutMetaQueryUrl(instance: HutInstance): string {
  const meta = instance.serviceOrigins.meta ?? `meta.${instance.origin}`;
  const base = meta.includes("://") ? meta : `https://${meta}`;
  return `${base.replace(/\/+$/, "")}/query`;
}

/**
 * Turn an `instance` block into what lookups need. Like hut 0.9, an instance without
 * `origin` takes its name as the domain.
 * @param directive - The block.
 * @returns {HutInstance} The instance.
 */
function instanceOf(directive: Directive): HutInstance {
  const name = directive.params[0] ?? "";
  const origin = hostOf(paramOf(directive, "origin") ?? name);
  const command = directive.children.find((child) => child.name === "access-token-cmd")?.params;
  const token = paramOf(directive, "access-token");
  return {
    name,
    origin,
    ...(token === undefined ? {} : { token }),
    ...(command === undefined || command.length === 0 ? {} : { command }),
    serviceOrigins: serviceOriginsOf(directive),
  };
}

/**
 * Collect each service's `origin` from an instance block, port and scheme kept.
 * @param directive - The `instance` block.
 * @returns {Record<string, string>} Service name to origin.
 */
function serviceOriginsOf(directive: Directive): Record<string, string> {
  const origins: Record<string, string> = {};
  for (const child of directive.children) {
    const origin = paramOf(child, "origin");
    if (child.children.length > 0 && origin !== undefined) origins[child.name] = origin;
  }
  return origins;
}

/**
 * Read the first parameter of a child directive.
 * @param directive - The parent block.
 * @param name - The child's name.
 * @returns {string | undefined} The parameter, or undefined when the child is missing.
 */
function paramOf(directive: Directive, name: string): string | undefined {
  return directive.children.find((child) => child.name === name)?.params[0];
}

/**
 * Reduce an origin to its host: hut writes the instance as `sr.ht` and services as URLs.
 * @param origin - A bare domain or a URL.
 * @returns {string} The host.
 */
function hostOf(origin: string): string {
  return origin.includes("://") ? (URL.parse(origin)?.hostname ?? origin) : origin;
}

/*
 * scfg is one directive per line, words split on whitespace with quotes and backslashes,
 * a trailing `{` opening a block and a lone `}` closing it, `#` starting a comment line.
 */

/** A run of quoted strings, escapes and plain characters, up to whitespace outside quotes. */
const WORD = /(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\\.|[^\s"'\\])+/g;
/** One piece of a word: a double-quoted part, a single-quoted part, an escape or a character. */
const PIECE = /"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|(\\.|.)/g;

/** Builds the directive tree line by line, keeping the open blocks to itself. */
class ScfgTree {
  readonly root: Directive[] = [];
  private readonly open: Directive[][] = [this.root];

  /**
   * Add one line: close a block, or append a directive and open its block. A stray `}`
   * is skipped, so it can't close the root and drop the rest of the file.
   * @param words - The line's words.
   */
  add(words: readonly string[]): void {
    if (words.length === 0) return;
    if (words.length === 1 && words[0] === "}") {
      if (this.open.length > 1) this.open.pop();
      return;
    }
    const opens = words.at(-1) === "{";
    const [name = "", ...params] = opens ? words.slice(0, -1) : words;
    const children: Directive[] = [];
    this.open.at(-1)?.push({ name, params, children });
    if (opens) this.open.push(children);
  }
}

/**
 * Parse an scfg document into its directive tree.
 * @param content - The whole file.
 * @returns {Directive[]} The top-level directives.
 */
export function parseScfg(content: string): Directive[] {
  const tree = new ScfgTree();
  for (const line of content.split(/\r?\n/)) tree.add(wordsOf(line.trim()));
  return tree.root;
}

/**
 * Split one line into words. A `#` line is a comment. A bare `{` stays a word of its own.
 * @param line - The trimmed line.
 * @returns {string[]} Its words, unquoted and unescaped.
 */
function wordsOf(line: string): string[] {
  if (line.startsWith("#")) return [];
  return Array.from(line.matchAll(WORD), ([word]) => unquote(word));
}

/**
 * Turn one word into its text, piece by piece. A backslash escapes the next character
 * everywhere, inside single quotes too, as in go-scfg.
 * @param word - The word as written.
 * @returns {string} The text.
 */
function unquote(word: string): string {
  return Array.from(word.matchAll(PIECE), ([, double, single, bare]) =>
    (double ?? single ?? bare ?? "").replaceAll(/\\(.)/g, "$1"),
  ).join("");
}
