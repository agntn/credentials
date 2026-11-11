import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createMcpServer } from "../src/mcp.ts";

const openConnections: Array<{ close(): Promise<void> }> = [];

async function connectTestClient(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer();
  const client = new Client({ name: "credentials-test", version: "1.0.0" });
  openConnections.push(client, server);
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function text(response: Awaited<ReturnType<Client["callTool"]>>): string {
  const [part] = response.content as Array<{ text: string }>;
  return part?.text ?? "";
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(openConnections.splice(0).map((connection) => connection.close()));
});

describe("credentials MCP server", () => {
  it("advertises credentials_list as a read-only tool with optional arguments", async () => {
    const client = await connectTestClient();

    const response = await client.listTools();

    expect(response.tools.map((tool) => tool.name)).toEqual(["credentials_list"]);
    expect(response.tools[0]?.title).toBe("List Credentials");
    expect(response.tools[0]?.inputSchema).toMatchObject({
      type: "object",
      properties: {
        service: {
          enum: [
            "github",
            "gitlab",
            "gitea",
            "gitee",
            "sourcehut",
            "bitbucket",
            "azure-devops",
            "pushin",
            "cursor-origin",
            "tangled",
            "cloudflare",
          ],
        },
        verify: { type: "boolean" },
      },
      additionalProperties: false,
    });
    expect(response.tools[0]?.inputSchema).not.toHaveProperty("required");
    expect(response.tools[0]?.annotations).toMatchObject({
      title: "List Credentials",
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    });
  });

  it("takes no host, so a model can't aim a token anywhere new", async () => {
    const client = await connectTestClient();

    const { tools } = await client.listTools();

    expect(Object.keys(tools[0]?.inputSchema.properties ?? {})).toEqual(["service", "verify"]);
  });

  it("lists what the environment holds without the token", async () => {
    vi.stubEnv("GH_TOKEN", "gho_mcp_secret");
    const client = await connectTestClient();

    const response = await client.callTool({ name: "credentials_list", arguments: {} });

    expect(response.isError).not.toBe(true);
    expect(text(response)).toBe(
      [
        "1 credential, not checked with the services. * marks the one resolve uses for its host. Tokens are never shown.",
        "github",
        "  * github.com | unknown account | GH_TOKEN (env) | unchecked",
        "gitlab: nothing found (set GITLAB_TOKEN or run glab auth login)",
        "gitea: nothing found (set GITEA_TOKEN or run tea login add)",
        "gitee: nothing found (set GITEE_TOKEN or GITEE_ACCESS_TOKEN)",
        "sourcehut: nothing found (set SRHT_TOKEN or run hut init)",
        "bitbucket: nothing found (set BITBUCKET_TOKEN, or BITBUCKET_API_TOKEN with BITBUCKET_EMAIL)",
        "azure-devops: nothing found (set AZURE_DEVOPS_EXT_PAT)",
        "pushin: nothing found (set PUSHIN_TOKEN or run pun login)",
        "cursor-origin: nothing found (set CURSOR_AUTH_TOKEN or run origin auth login)",
        "tangled: nothing found (set TANGLED_HANDLE and TANGLED_PASSWORD, an app password)",
        "cloudflare: nothing found (set CLOUDFLARE_API_TOKEN or run cf auth login)",
        "Unchecked entries are only known to exist. Run again with verify (--verify in the CLI) to ask each service.",
      ].join("\n"),
    );
    expect(JSON.stringify(response)).not.toContain("gho_mcp_secret");
  });

  it("rejects a key the schema doesn't know and an unknown service", async () => {
    const client = await connectTestClient();

    const unknown = await client.callTool({
      name: "credentials_list",
      arguments: { servic: "github" },
    });
    const outside = await client.callTool({
      name: "credentials_list",
      arguments: { service: "launchpad" },
    });

    expect(unknown.isError).toBe(true);
    expect(text(unknown)).toContain('unknown property "servic"');
    expect(outside.isError).toBe(true);
    expect(text(outside)).toContain(
      "must be one of github, gitlab, gitea, gitee, sourcehut, bitbucket, azure-devops, pushin, cursor-origin, tangled, cloudflare",
    );
  });
});
