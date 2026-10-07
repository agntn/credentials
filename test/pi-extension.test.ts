import { fileURLToPath } from "node:url";

import { wireSchema } from "@agntn/tools";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { listTool } from "../src/tools.ts";
import { loadPiExtension } from "./fixtures/pi-host.ts";

const extensionPath = fileURLToPath(
  new URL("../packages/pi/extensions/credentials.ts", import.meta.url),
);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("pi credentials extension", () => {
  it("registers credentials_list and nothing else", async () => {
    const host = await loadPiExtension(extensionPath);

    expect([...host.tools.keys()]).toEqual(["credentials_list"]);
  });

  it("hands Pi the shared schema and refuses what it rejects", async () => {
    const host = await loadPiExtension(extensionPath);
    const tool = host.tool("credentials_list");
    const outcome = async (args: Record<string, unknown>): Promise<string> =>
      Promise.resolve(tool.execute("call-1", args, undefined, undefined, host.context)).then(
        () => "ran",
        (error: unknown) =>
          error instanceof Error && error.message.startsWith("Invalid arguments")
            ? "refused"
            : "failed",
      );

    expect(tool.parameters).toEqual(wireSchema(listTool));
    expect(await outcome({})).toBe("ran");
    expect(await outcome({ service: "gitea" })).toBe("ran");
    expect(await outcome({ service: "bitbucket" })).toBe("refused");
    expect(await outcome({ verify: "yes" })).toBe("refused");
    expect(await outcome({ token: "x" })).toBe("refused");
  });

  it("executes through the shared executor and returns structured details", async () => {
    vi.stubEnv("GITLAB_TOKEN", "glpat-pi-secret");
    const host = await loadPiExtension(extensionPath);

    const result = await host
      .tool("credentials_list")
      .execute("call-1", { service: "gitlab" }, undefined, undefined, host.context);

    expect(result.content[0]?.type).toBe("text");
    expect(result.details).toMatchObject({
      services: ["gitlab"],
      verified: false,
      credentials: [{ service: "gitlab", host: "gitlab.com", origin: "GITLAB_TOKEN" }],
    });
    expect(JSON.stringify(result)).not.toContain("glpat-pi-secret");
  });
});
