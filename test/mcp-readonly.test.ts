import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { version } from "../package.json";

describe("read-only MCP", () => {
  test("advertises the package version and omits every mutation", async () => {
    const transport = new StdioClientTransport({
      command: "bun", args: ["run", "src/index.ts", "mcp", "serve", "--read-only"],
      env: { ...process.env, LINEAR_API_KEY: "offline-handshake-only" } as Record<string, string>,
    });
    const client = new Client({ name: "read-only-contract", version: "1" });
    try {
      await client.connect(transport);
      expect(client.getServerVersion()?.version).toBe(version);
      const { tools } = await client.listTools();
      expect(tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
      const names = tools.map((tool) => tool.name);
      for (const read of ["issue_comments", "cortex_repo_query", "triage", "project_list"]) expect(names).toContain(read);
      for (const write of ["file_issue", "comment_issue", "issue_close", "issue_update", "project_create", "project_overview_set"]) {
        expect(names).not.toContain(write);
      }
      const denied = await client.callTool({ name: "comment_issue", arguments: { id: "ENG-1", body: "must not post" } });
      expect(denied.isError).toBe(true);
    } finally { await client.close(); }
  }, 30_000);
});
