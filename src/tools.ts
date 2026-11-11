/** The credentials tool, declared once for every surface. The executor loads on the first call. */

import { defineTool, Type, type ToolDefinition } from "@agntn/tools";
import { SERVICES } from "./tool-contract.ts";

type ToolOperations = typeof import("./tool-operations.ts");

let operations: Promise<ToolOperations> | undefined;

/**
 * Loads the executors once. A failed load isn't cached, so a broken `dist` doesn't stick.
 *
 * @returns {Promise<ToolOperations>} The executors.
 */
export function loadOperations(): Promise<ToolOperations> {
  operations ??= import("./tool-operations.ts").catch((error: unknown) => {
    operations = undefined;
    throw error;
  });
  return operations;
}

export const listTool = defineTool({
  name: "credentials_list",
  title: "List Credentials",
  description:
    "List the GitHub, GitLab, Gitea, Sourcehut and Cloudflare credentials this machine holds: token variables, gh/glab/tea/hut logins and the cf OAuth session. Each line gives the host, account, where it came from, its state and expiry, and * marks the one other agntn packages will use. Tokens are never shown. With verify, each service is asked whether it still accepts its credential, on that credential's own host only; without it nothing goes over the network except cf, which always checks its own session.",
  snippet:
    "Use credentials_list to see which GitHub, GitLab, Gitea, Sourcehut and Cloudflare credentials exist, which one is active and whether they still work.",
  guidelines: [
    "Pass verify: true to find out whether a credential is still accepted, not just present.",
    "The tool never returns a token. Ask the user to log in with gh, glab, tea, hut or cf when one is missing.",
  ],
  effect: "read",
  /** `verify` and cf both reach the services. */
  openWorld: true,
  cli: {
    command: "list",
    description: "Credentials on this machine, without the tokens",
    positional: ["service"],
  },
  input: Type.Object(
    {
      service: Type.Optional(
        Type.Enum([...SERVICES], { description: "Only this service. Omit for all of them" }),
      ),
      verify: Type.Optional(
        Type.Boolean({
          description: "Ask each service whether it accepts the credential. Default false",
        }),
      ),
    },
    { additionalProperties: false },
  ),
  execute: async (input) => (await loadOperations()).listCredentials(input),
});

export const credentialsTools: readonly ToolDefinition[] = [listTool];
