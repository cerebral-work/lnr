import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Separate processes keep fixture PATH and credentials out of other tests.
async function observe(script: string) {
  const directory = mkdtempSync(join(tmpdir(), "lnr-cortex-"));
  const fake = join(directory, "cortex");
  writeFileSync(fake, '#!/bin/sh\n[ "$*" = "repo-query --json --max-patch-bytes 0" ] || exit 8\n[ "${LINEAR_API_KEY+x}" != x ] || exit 9\n' + script, { mode: 0o700 });
  try {
    const child = Bun.spawn(["bun", "-e", 'import { cortexRepoQuery } from "./src/core/cortex.ts"; console.log(JSON.stringify(await cortexRepoQuery()));'], {
      cwd: process.cwd(), env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, LINEAR_API_KEY: "fixture-secret-must-not-propagate" },
      stdout: "pipe", stderr: "pipe",
    });
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, out, err };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

describe("Cortex observation adapter", () => {
  test("uses a fixed read-only command, drops the Linear key, preserves observation authority", async () => {
    const result = await observe(`echo '{"document_type":"cortex-resident-repo-query","schema_version":1,"authority":"observation_only","head_sha":"abc"}'\n`);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out).authority).toBe("observation_only");
    expect(JSON.parse(result.out).head_sha).toBe("abc");
  });
  test("rejects an incompatible authority contract", async () => {
    const result = await observe(`echo '{"document_type":"cortex-resident-repo-query","schema_version":1,"authority":"approved"}'\n`);
    expect(result.code).not.toBe(0);
    expect(result.err).toContain("Unsupported Cortex");
  });
  test("rejects oversized output without returning partial evidence", async () => {
    const result = await observe("head -c 131073 /dev/zero\n");
    expect(result.code).not.toBe(0);
    expect(result.out).toBe("");
  });
  test("rejects malformed JSON", async () => {
    const result = await observe("echo not-json\n");
    expect(result.code).not.toBe(0);
    expect(result.err).toContain("invalid JSON");
  });
});
