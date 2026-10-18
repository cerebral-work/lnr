import { describe, expect, test } from "bun:test";
import type { LinearClient } from "@linear/sdk";
import { join } from "node:path";
import { createTeam } from "../src/core/teams.js";
import { teamCreate } from "../src/commands/team.js";
import { CliError } from "../src/lib/errors.js";

type StubTeam = { id: string; key: string; name: string; description?: string | null };

function stubClient(existing: StubTeam[], create: { success: boolean; team?: StubTeam | null }) {
  const filters: string[] = [];
  const creates: Record<string, unknown>[] = [];
  const client = {
    teams: (args?: { filter?: { key?: { eqIgnoreCase?: string } } }) => {
      const k = args?.filter?.key?.eqIgnoreCase ?? "";
      filters.push(k);
      return Promise.resolve({ nodes: existing.filter((t) => t.key.toLowerCase() === k.toLowerCase()) });
    },
    createTeam: (input: Record<string, unknown>) => {
      creates.push(input);
      return Promise.resolve({ success: create.success, team: Promise.resolve(create.team ?? undefined) });
    },
  } as unknown as LinearClient;
  return { client, filters, creates };
}

describe("createTeam", () => {
  test("returns the existing team for a key that already exists, without creating", async () => {
    const { client, filters, creates } = stubClient(
      [{ id: "t-core", key: "CORE", name: "Core Architecture", description: null }],
      { success: true },
    );
    const team = await createTeam(client, { key: " core ", name: "Anything" });
    expect(team).toEqual({ id: "t-core", key: "CORE", name: "Core Architecture", description: null });
    expect(filters).toEqual(["CORE"]);
    expect(creates).toEqual([]);
  });

  test("creates a missing team with the key upper-cased and the name trimmed", async () => {
    const created = { id: "t-new", key: "CORE", name: "Core Architecture", description: "Platform core" };
    const { client, creates } = stubClient([], { success: true, team: created });
    const team = await createTeam(client, { key: "core", name: "  Core Architecture ", description: "Platform core" });
    expect(creates).toEqual([{ key: "CORE", name: "Core Architecture", description: "Platform core" }]);
    expect(team).toEqual(created);
  });

  test("omits the description when none is given", async () => {
    const { client, creates } = stubClient([], { success: true, team: { id: "t", key: "OPS", name: "Ops" } });
    const team = await createTeam(client, { key: "OPS", name: "Ops" });
    expect(creates).toEqual([{ key: "OPS", name: "Ops" }]);
    expect(team.description).toBeNull();
  });

  test("fails when Linear reports the create did not succeed", async () => {
    const { client } = stubClient([], { success: false });
    await expect(createTeam(client, { key: "OPS", name: "Ops" })).rejects.toThrow(/did not succeed/);
  });

  test("fails when the payload returns no team", async () => {
    const { client } = stubClient([], { success: true, team: null });
    await expect(createTeam(client, { key: "OPS", name: "Ops" })).rejects.toThrow(/returned no team/);
  });
});

describe("teamCreate", () => {
  test("a missing or blank key or name is a usage error, before any client is built", async () => {
    for (const [key, name] of [[undefined, "Ops"], ["OPS", undefined], ["  ", "Ops"], ["OPS", "  "]]) {
      let thrown: unknown;
      try { await teamCreate(key, name, {}); } catch (err) { thrown = err; }
      expect(thrown).toBeInstanceOf(CliError);
      expect((thrown as CliError).kind).toBe("usage");
      expect((thrown as CliError).message).toContain("team create requires <key> and <name>");
    }
  });

  test("`team create` is registered with its arguments and options", () => {
    const res = Bun.spawnSync([process.execPath, "src/index.ts", "team", "create", "--help"], {
      cwd: join(import.meta.dir, ".."), env: { ...process.env, NO_COLOR: "1" }, stdout: "pipe", stderr: "pipe",
    });
    const out = res.stdout.toString();
    expect(res.exitCode).toBe(0);
    expect(out).toContain("<key>");
    expect(out).toContain("<name>");
    expect(out).toContain("--desc <text>");
    expect(out).toContain("idempotent");
  });
});
