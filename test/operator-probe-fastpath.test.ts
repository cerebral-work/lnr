import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { startOperator } from "../src/core/operator.js";
import { parseProbeArgs } from "../src/lib/operator-probe.js";

/**
 * Probe fast path (CER-4207). The kubelet runs `operator --health` and
 * `operator --check` as exec probes; `src/main.ts` answers those two forms from
 * `src/lib/operator-probe.ts` without loading the full CLI bundle, and hands
 * every other invocation to `src/index.ts`.
 */

const root = join(import.meta.dir, "..");

function tempSocketPath(): string {
  return join(mkdtempSync(join(tmpdir(), "linearctl-fastpath-")), "operator.sock");
}

function runMain(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["run", join(root, "src/main.ts"), ...args], {
      cwd: root,
      env: { ...process.env, LINEARCTL_OPERATOR_TIMEOUT: "" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("parseProbeArgs", () => {
  test("accepts the probe forms the chart and runbooks use", () => {
    expect(parseProbeArgs(["operator", "--health"])).toMatchObject({ kind: "health", json: false });
    expect(parseProbeArgs(["operator", "--check"])).toMatchObject({ kind: "check", json: false });
    expect(parseProbeArgs(["operator", "--check", "--json", "--socket", "/s", "--timeout", "500"])).toEqual({
      kind: "check",
      json: true,
      socket: "/s",
      timeout: "500",
    });
  });

  test("hands everything else to the full CLI", () => {
    for (const argv of [
      [],
      ["operator"],
      ["operator", "--role", "grooming"],
      ["operator", "--health", "--check"],
      ["operator", "--health", "--health"],
      ["operator", "--health", "--json", "--json"],
      ["operator", "--health", "--socket"],
      ["operator", "--health", "--socket", "--json"],
      ["operator", "--health", "--socket=/s"],
      ["operator", "--health", "--namespace", "x"],
      ["operator", "--health", "--help"],
      ["watch", "--health"],
      ["--health"],
    ]) {
      expect(parseProbeArgs(argv)).toBeNull();
    }
  });
});

describe("probe module stays light", () => {
  // The fast path is only cheap while these modules import nothing but each
  // other and node built-ins. A heavy import here undoes the fix silently.
  test("operator-probe, control-socket and errors import only node built-ins and each other", () => {
    const allowed = new Set(["./errors.js", "./control-socket.js"]);
    for (const file of ["src/lib/operator-probe.ts", "src/lib/control-socket.ts", "src/lib/errors.ts", "src/main.ts"]) {
      const src = readFileSync(join(root, file), "utf8");
      const specifiers = [...src.matchAll(/^import\s[^;]*?from\s+"([^"]+)"/gms)].map((m) => m[1]);
      for (const spec of specifiers) {
        const ok = spec.startsWith("node:") || allowed.has(spec) || (file === "src/main.ts" && spec === "./lib/operator-probe.js");
        expect({ file, spec, ok }).toEqual({ file, spec, ok: true });
      }
    }
  });

  // Without --splitting, bun inlines the whole CLI into the entry chunk and
  // the probe pays for parsing it again (measured: 0.2 s CPU vs 0.02 s).
  test("the image build compiles src/main.ts with --splitting", () => {
    const build: string = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts.build;
    expect(build).toContain("./src/main.ts");
    expect(build).toContain("--splitting");
  });
});

describe("src/main.ts", () => {
  test("--health against a live operator exits 0 through the fast path", async () => {
    const handle = await startOperator({
      socketPath: tempSocketPath(),
      registerSignals: false,
      tokenMinter: async () => "opaque-minted-token",
      eventLoopRunner: async () => ({ thoughtId: "t", responseId: "r", movedToStateId: null }),
      queueEnv: null,
    });
    try {
      const res = await runMain(["operator", "--health", "--json", "--socket", handle.socketPath]);
      expect(res.code).toBe(0);
      expect(JSON.parse(res.stdout).ok).toBe(true);
      // --check: no CF env, so not ready (exit 1) with the report on stdout.
      const check = await runMain(["operator", "--check", "--json", "--socket", handle.socketPath]);
      expect(check.code).toBe(1);
      expect(JSON.parse(check.stdout).ok).toBe(false);
    } finally {
      await handle.stop();
    }
  });

  test("--health with no operator exits 1 with a diagnostic", async () => {
    const res = await runMain(["operator", "--health", "--socket", tempSocketPath()]);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("not alive");
  });

  test("a bad --timeout is a usage error (exit 2)", async () => {
    const res = await runMain(["operator", "--check", "--socket", tempSocketPath(), "--timeout", "abc"]);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("--timeout must be a positive number");
  });

  test("other invocations reach the full CLI", async () => {
    const both = await runMain(["operator", "--health", "--check"]);
    expect(both.code).toBe(2);
    expect(both.stderr).toContain("mutually exclusive");
    const unknown = await runMain(["bogus"]);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain("unknown command 'bogus'");
  });
});
