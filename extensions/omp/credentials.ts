import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { registerOmpTools, type OmpResultView } from "@agntn/tools/omp";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

import type * as CredentialsTools from "../../dist/tools.d.mts";

/** Longest service name on the status line, cut before `sanitizeLine`, which is slow on long escapes. */
const PREVIEW_LENGTH = 32;

const sourceModulePath = fileURLToPath(new URL("../../src/tools.ts", import.meta.url));

/**
 * Both specifiers stay literal: compiled OMP resolves bare imports only where it sees them.
 *
 * @returns {Promise<typeof CredentialsTools>} The definitions and the executor loader.
 */
function loadTools(): Promise<typeof CredentialsTools> {
  return (
    existsSync(sourceModulePath) ? import("../../src/tools.ts") : import("../../dist/tools.mjs")
  ) as Promise<typeof CredentialsTools>;
}

/**
 * Counts the credentials and how many of them still work, or nothing for a result without them.
 *
 * @param result - Tool result from the host.
 * @returns {string[]} One entry per fact.
 */
function describeCredentials(result: OmpResultView): string[] {
  const { details } = result;
  if (typeof details !== "object" || details === null || !("credentials" in details)) return [];
  const { credentials } = details as { credentials?: unknown };
  if (!Array.isArray(credentials)) return [];
  const states = credentials.map((entry: unknown) =>
    typeof entry === "object" && entry !== null && "state" in entry ? String(entry.state) : "",
  );
  const count = (state: string): number => states.filter((value) => value === state).length;
  return [
    `${credentials.length} found`,
    `${count("valid")} valid`,
    `${count("rejected") + count("expired")} failing`,
  ];
}

/**
 * Registers the credentials tool; the executors load on the first call.
 *
 * @param pi - OMP extension API supplied by the host.
 */
export default async function credentialsExtension(pi: ExtensionAPI): Promise<void> {
  pi.setLabel("Credentials");
  const { credentialsTools } = await loadTools();
  registerOmpTools(pi, credentialsTools, {
    Text: pi.pi.Text,
    renderers: {
      credentials_list: {
        describeCall: (args) =>
          [
            typeof args["service"] === "string" ? args["service"].slice(0, PREVIEW_LENGTH) : "all",
            args["verify"] === true ? "verify" : "",
          ]
            .filter(Boolean)
            .join(" "),
        describeResult: describeCredentials,
      },
    },
  });
}
