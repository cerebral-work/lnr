import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { makeClient } from "../client.js";
import { registerTools } from "./tools.js";
import { version } from "../../package.json";

/**
 * `linearctl mcp serve` — run the stdio MCP server exposing the linearctl tools.
 *
 * One entry point, two consumers: the Claude Code plugin and the Claude Desktop
 * `.mcpb` extension both launch this. The server speaks JSON-RPC on **stdout**,
 * so nothing here may write to stdout — `makeClient` validates the API key at
 * startup and logs only to stderr (exiting before `connect` if it is missing,
 * so failure is a clean "not configured", never a mid-handshake crash).
 *
 * See docs/plugin-spec.md §2–§3.
 */
export async function serve(options: { readOnly?: boolean } = {}): Promise<void> {
  const client = makeClient();

  const server = new McpServer({
    name: "linearctl",
    version,
  });

  registerTools(server, client, options);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
