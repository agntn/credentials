/** Vercel AI SDK tool surface over the shared credentials tool definition. */

import { toAiTool, type AiToolOutput } from "@agntn/tools/ai";
import type { Tool } from "ai";
import type { Service } from "./core/types.ts";
import type { ListDetails } from "./tool-operations.ts";
import { listTool } from "./tools.ts";

/** The arguments the model sends, as the schema types them. */
export interface ListArguments {
  service?: Service;
  verify?: boolean;
}

export const credentialsListTool: Tool<ListArguments, AiToolOutput<ListDetails>> = toAiTool(
  listTool,
);

/** Every credentials tool, keyed by the name MCP, Pi and OMP use for it. */
export const credentialsAiTools = {
  credentials_list: credentialsListTool,
};
