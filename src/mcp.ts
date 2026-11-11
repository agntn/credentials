import { callTool, createMcpServer as createToolServer, errorResult } from "@agntn/tools/mcp";
import type { Server } from "@modelcontextprotocol/server";
import { sourceChangeCheck } from "./source-change.ts";
import { credentialsTools } from "./tools.ts";
import { version } from "./version.ts";

const restart = "src/ changed under this server, restart it to load the new code";

/** The baseline is the process start, so a pull during startup counts. */
const changed = import.meta.url.endsWith(".ts")
  ? sourceChangeCheck(import.meta.dirname, performance.timeOrigin)
  : undefined;

/**
 * Creates an unconnected MCP server exposing the credentials tool. Run from `src/`, it answers with
 * a restart line before and after every call once that tree changed, a success included.
 *
 * @returns {Server} Unconnected MCP server.
 */
export function createMcpServer(): Server {
  const info = { name: "credentials", version };
  const server = createToolServer(info, credentialsTools);
  if (!changed) return server;

  server.setRequestHandler("tools/call", async (request, ctx) => {
    if (changed()) return errorResult(restart);
    const result = await callTool(
      info,
      credentialsTools,
      request.params.name,
      request.params.arguments,
      {
        signal: ctx.mcpReq.signal,
      },
    );
    return changed() ? errorResult(restart) : result;
  });
  return server;
}
