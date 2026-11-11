/**
 * Tool executors behind the definitions in `tools.ts`, loaded on the first call.
 *
 * Each executor returns the text a caller reads plus the structured details the
 * agent harnesses attach to the call. An MCP client sees only the text, so every
 * fact needed for a follow-up call has to be in it. No executor ever touches a token:
 * they read `list`, which never returns one.
 */

import { sanitizeLine, ToolInputError } from "@agntn/tools";
import { list as listAzureDevOps } from "./azure-devops.ts";
import { list as listBitbucket } from "./bitbucket.ts";
import { list as listCloudflare } from "./cloudflare.ts";
import type { CredentialInfo, Service } from "./core/types.ts";
import { list as listCursorOrigin } from "./cursor-origin.ts";
import { list as listGitea } from "./gitea.ts";
import { list as listGitee } from "./gitee.ts";
import { list as listGithub } from "./github.ts";
import { list as listGitlab } from "./gitlab.ts";
import { list as listPushin } from "./pushin.ts";
import { list as listSourcehut } from "./sourcehut.ts";
import { SERVICES } from "./tool-contract.ts";

/**
 * Text for the model plus details for the harness, shared by every tool surface.
 * A failure throws instead: Pi records every returned value as a successful call.
 */
export interface ToolResult<Details> {
  content: Array<{ type: "text"; text: string }>;
  details: Details;
}

interface ListInput {
  readonly service?: string;
  readonly verify?: boolean;
}

export interface ListDetails {
  readonly services: readonly Service[];
  readonly verified: boolean;
  readonly credentials: readonly CredentialInfo[];
}

const LISTERS: Record<
  Service,
  (options: Readonly<{ verify: boolean }>) => Promise<CredentialInfo[]>
> = {
  github: listGithub,
  gitlab: listGitlab,
  gitea: listGitea,
  gitee: listGitee,
  sourcehut: listSourcehut,
  bitbucket: listBitbucket,
  "azure-devops": listAzureDevOps,
  pushin: listPushin,
  "cursor-origin": listCursorOrigin,
  cloudflare: listCloudflare,
};

/** Hints shown for a service with nothing found. */
const SETUP: Record<Service, string> = {
  github: "set GH_TOKEN or run gh auth login",
  gitlab: "set GITLAB_TOKEN or run glab auth login",
  gitea: "set GITEA_TOKEN or run tea login add",
  gitee: "set GITEE_TOKEN or GITEE_ACCESS_TOKEN",
  sourcehut: "set SRHT_TOKEN or run hut init",
  bitbucket: "set BITBUCKET_TOKEN, or BITBUCKET_API_TOKEN with BITBUCKET_EMAIL",
  "azure-devops": "set AZURE_DEVOPS_EXT_PAT",
  pushin: "set PUSHIN_TOKEN or run pun login",
  "cursor-origin": "set CURSOR_AUTH_TOKEN or run origin auth login",
  cloudflare: "set CLOUDFLARE_API_TOKEN or run cf auth login",
};

/** A scope list longer than this is shown as a count; `details` keeps every scope. */
const MAX_SCOPES_SHOWN = 8;

/**
 * List the credentials of one service or all of them, without any token.
 *
 * The arguments are checked here, not only in the schema: a caller can reach the
 * executor without it.
 *
 * @param input - Service filter and whether to ask the services.
 * @returns {Promise<ToolResult<ListDetails>>} One line per credential, grouped by service.
 * @throws {ToolInputError} When an argument breaks the contract.
 */
export async function listCredentials(input: ListInput): Promise<ToolResult<ListDetails>> {
  const services = selectedServices(input.service);
  const verify = flag(input.verify, "verify");
  const now = Date.now();
  // The forge listers run their CLIs synchronously, so cf, which waits on the network, starts first.
  const started = new Map(
    [...services]
      .sort((a, b) => Number(b === "cloudflare") - Number(a === "cloudflare"))
      .map((service) => [service, LISTERS[service]({ verify })] as const),
  );
  const found = await Promise.all(services.map((service) => started.get(service)!));
  const credentials = found.flat();

  const lines = [heading(credentials.length, verify)];
  services.forEach((service, index) => {
    const entries = found[index] ?? [];
    if (entries.length === 0) {
      lines.push(`${service}: nothing found (${SETUP[service]})`);
      return;
    }
    lines.push(service, ...entries.map((entry) => entryLine(entry, now)));
  });
  if (!verify && credentials.some((entry) => entry.state === "unchecked")) {
    lines.push(
      "Unchecked entries are only known to exist. Run again with verify (--verify in the CLI) to ask each service.",
    );
  }

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    details: { services, verified: verify, credentials },
  };
}

/**
 * Resolve the service filter.
 * @param service - The caller's filter, if any.
 * @returns {Service[]} The services to list.
 * @throws {ToolInputError} When the name is not one of the four.
 */
function selectedServices(service: unknown): Service[] {
  if (service === undefined) return [...SERVICES];
  if (typeof service === "string" && (SERVICES as readonly string[]).includes(service)) {
    return [service as Service];
  }
  throw new ToolInputError([
    `Unknown service ${JSON.stringify(sanitizeLine(service))}: use one of ${SERVICES.join(", ")}`,
  ]);
}

/**
 * Read an optional boolean, refusing anything that only looks like one.
 * @param value - The argument.
 * @param name - Its name, for the error.
 * @returns {boolean} The value, false when absent.
 * @throws {ToolInputError} When the value is not a boolean.
 */
function flag(value: unknown, name: string): boolean {
  if (value === undefined) return false;
  if (typeof value === "boolean") return value;
  throw new ToolInputError([`${name} must be true or false`]);
}

/**
 * The first line, with the count and the legend.
 * @param count - Credentials found.
 * @param verify - Whether the services were asked.
 * @returns {string} The heading.
 */
function heading(count: number, verify: boolean): string {
  const noun = count === 1 ? "credential" : "credentials";
  const checked = verify ? "checked with each service" : "not checked with the services";
  return `${count} ${noun}, ${checked}. * marks the one resolve uses for its host. Tokens are never shown.`;
}

/**
 * One credential as a line. Every value from a file, a CLI or a service goes through
 * `sanitizeLine`, so none of them can forge a line of its own.
 * @param entry - The credential.
 * @param now - The time to measure expiry against.
 * @returns {string} The line.
 */
function entryLine(entry: CredentialInfo, now: number): string {
  const parts = [
    entry.host,
    entry.account ?? "unknown account",
    `${entry.origin} (${entry.source})`,
    entry.state,
  ];
  if (entry.expiresAt !== undefined) parts.push(expiry(entry.expiresAt, now));
  if (entry.accountId !== undefined) {
    parts.push(`account id ${entry.accountId} from ${entry.accountIdOrigin ?? "unknown"}`);
  }
  parts.push(...scopeText(entry.scopes));
  if (entry.note !== undefined) parts.push(entry.note);
  return `  ${entry.active ? "*" : " "} ${sanitizeLine(parts.join(" | "))}`;
}

/**
 * Show the scopes, or their count when the list is long.
 * @param scopes - The scopes, if known.
 * @returns {string[]} Nothing, or one part for the line.
 */
function scopeText(scopes: readonly string[] | undefined): string[] {
  if (scopes === undefined || scopes.length === 0) return [];
  if (scopes.length > MAX_SCOPES_SHOWN) return [`${scopes.length} scopes`];
  return [`scopes ${scopes.join(", ")}`];
}

/**
 * Say when a credential expires, or how long ago it did.
 * @param expiresAt - Milliseconds since the epoch.
 * @param now - The current time.
 * @returns {string} Such as `expires 2026-10-07T18:25:49Z (in 27 min)`.
 */
function expiry(expiresAt: number, now: number): string {
  const at = new Date(expiresAt).toISOString().replace(/\.\d{3}Z$/, "Z");
  const minutes = Math.round((expiresAt - now) / 60_000);
  if (minutes < 0) return `expired ${at} (${span(-minutes)} ago)`;
  return `expires ${at} (in ${span(minutes)})`;
}

/**
 * Write a span of minutes in the largest unit that keeps it readable.
 * @param minutes - A non-negative span.
 * @returns {string} Such as `27 min`, `5 h` or `12 days`.
 */
function span(minutes: number): string {
  if (minutes < 120) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(hours / 24)} days`;
}
