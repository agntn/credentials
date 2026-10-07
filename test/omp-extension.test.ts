import { ToolInputError, wireSchema } from "@agntn/tools";
import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

/** Compiled OMP injects no TUI barrel, so loading it has to fail the test. */
vi.mock("@oh-my-pi/pi-coding-agent/tui", () => {
  throw new Error("The OMP host does not inject the TUI barrel");
});

import credentialsExtension from "../packages/omp/extensions/credentials.ts";
import { listTool } from "../src/tools.ts";
import {
  ompTestTheme as theme,
  ompToolContext,
  registerOmpExtension,
} from "./fixtures/omp-host.ts";

const CONTROL_BYTES = /[\u0000-\u001F\u007F-\u009F]/;

async function registerListTool(): Promise<ToolDefinition> {
  return (await registerOmpExtension(credentialsExtension)).tool("credentials_list");
}

function renderedText(component: unknown): string {
  return (component as { text: string }).text;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("omp credentials extension", () => {
  it("registers credentials_list as a read-approval tool", async () => {
    const host = await registerOmpExtension(credentialsExtension);
    const tool = host.tool("credentials_list");

    expect([...host.tools.keys()]).toEqual(["credentials_list"]);
    expect(host.labels).toEqual(["Credentials"]);
    expect(tool.name).toBe("credentials_list");
    expect(tool.label).toBe("List Credentials");
    expect(tool.approval).toBe("read");
  });

  it("hands OMP the shared schema and refuses what it rejects", async () => {
    const tool = await registerListTool();
    const outcome = async (args: Record<string, unknown>): Promise<string> =>
      Promise.resolve(tool.execute("call-1", args, undefined, undefined, ompToolContext)).then(
        () => "ran",
        (error: unknown) => (error instanceof ToolInputError ? "refused" : "failed"),
      );

    expect(tool.parameters).toEqual(wireSchema(listTool));
    expect(await outcome({})).toBe("ran");
    expect(await outcome({ service: "bitbucket" })).toBe("refused");
    expect(await outcome({ verify: 1 })).toBe("refused");
  });

  it("executes against the library and returns structured details", async () => {
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "cf-omp-secret");
    const tool = await registerListTool();

    const result = await tool.execute(
      "call-1",
      { service: "cloudflare" },
      undefined,
      undefined,
      ompToolContext,
    );

    expect(result.details).toMatchObject({
      services: ["cloudflare"],
      credentials: [{ origin: "CLOUDFLARE_API_TOKEN", active: true }],
    });
    expect(JSON.stringify(result)).not.toContain("cf-omp-secret");
  });

  it.each([
    [false, undefined, "success:status.done"],
    [true, undefined, "muted:status.pending"],
    [true, 3, "frame-1"],
  ] as const)(
    "draws the call status with the host theme (partial=%s, frame=%s)",
    async (isPartial, spinnerFrame, icon) => {
      const tool = await registerListTool();

      const text = renderedText(
        tool.renderCall?.(
          { service: "github", verify: true },
          { expanded: false, isPartial, spinnerFrame },
          theme,
        ),
      );

      expect(text).toBe(`${icon} accent(List Credentials): muted(github verify)`);
    },
  );

  it("names every service when the call picks none", async () => {
    const tool = await registerListTool();

    const text = renderedText(tool.renderCall?.({}, { expanded: false, isPartial: false }, theme));

    expect(text).toBe("success:status.done accent(List Credentials): muted(all)");
  });

  it("sanitizes model arguments in renderCall", async () => {
    const tool = await registerListTool();
    const hostile = { service: "\u001B]0;evil\u0007git hub‮" };

    const text = renderedText(
      tool.renderCall?.(hostile, { expanded: false, isPartial: false }, theme),
    );

    expect(text).not.toMatch(CONTROL_BYTES);
    expect(text).not.toContain(" ");
    expect(text).not.toContain("‮");
  });

  it("cuts a long argument before sanitizing it", async () => {
    const tool = await registerListTool();
    const started = performance.now();

    tool.renderCall?.(
      { service: "\u001B]".repeat(100_000) },
      { expanded: false, isPartial: true },
      theme,
    );

    expect(performance.now() - started).toBeLessThan(500);
  });

  it("counts found, valid and failing credentials in renderResult", async () => {
    const tool = await registerListTool();
    const result = {
      content: [{ type: "text" as const, text: "ok" }],
      details: {
        credentials: [
          { state: "valid" },
          { state: "rejected" },
          { state: "expired" },
          { state: "unchecked" },
        ],
      },
    };

    const text = renderedText(
      tool.renderResult?.(result, { expanded: false, isPartial: false }, theme),
    );

    expect(text).toBe(
      "success:status.done accent(List Credentials) accent([read]) dim(4 found | 1 valid | 2 failing)",
    );
  });

  it("marks an error result with the error icon and no meta", async () => {
    const tool = await registerListTool();
    const result = { content: [{ type: "text" as const, text: "boom" }], isError: true };

    const text = renderedText(
      tool.renderResult?.(result, { expanded: false, isPartial: false }, theme),
    );

    expect(text).toBe("error:status.error accent(List Credentials) accent([read])");
  });
});
