import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { LinearClient } from "@linear/sdk";
import { startOperator, type OperatorOptions, type TokenMinter } from "../src/core/operator.js";
import { getRole, type RoleRunResult } from "../src/core/role-catalog.js";
import type { Preflight } from "../src/core/scheduler.js";
import type { AgentSessionEvent } from "../src/core/watch.js";
import { makeControlClient } from "../src/lib/control-socket.js";

/**
 * CER-3309: the operator's app token expires after 30 days, and the roles must
 * re-mint on Linear's 401 instead of failing every run until the pod restarts.
 *
 * The test drives the real daemon (control socket, role scheduler, queue loop),
 * the real @linear/sdk client and the real `operator --check` subprocess.
 * Linear itself is a local HTTP server that answers an unknown bearer token with
 * the exact 401 body api.linear.app returned on 2026-11-25 for a rejected token.
 */

const LINEAR_401_BODY = {
  errors: [
    {
      message: "Authentication required, not authenticated",
      extensions: {
        type: "authentication error",
        code: "AUTHENTICATION_ERROR",
        statusCode: 401,
        userError: true,
        userPresentableMessage: "You need to authenticate to access this operation.",
        meta: {},
        http: { status: 401 },
      },
    },
  ],
};

/** A Linear GraphQL stand-in: accepts only the tokens in `valid`, records every bearer it sees. */
function fakeLinear(valid: ReadonlySet<string>) {
  const seen: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const token = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
      seen.push(token);
      if (!valid.has(token)) {
        return new Response(JSON.stringify(LINEAR_401_BODY), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }
      return Response.json({ data: { viewer: { id: "app-actor", name: "linearctl", email: "bot@example.invalid" } } });
    },
  });
  return { url: `http://127.0.0.1:${server.port}/graphql`, seen, stop: () => server.stop(true) };
}

/** Mints the given tokens in order, then repeats the last one. Counts every mint. */
function sequenceMinter(tokens: string[]): { minter: TokenMinter; mints: () => number } {
  let n = 0;
  return {
    minter: async () => tokens[Math.min(n++, tokens.length - 1)]!,
    mints: () => n,
  };
}

/** A role runner that makes one real SDK call against the stand-in. */
const viewerRunner =
  (apiUrl: string) =>
  async (token: string): Promise<RoleRunResult> => {
    const viewer = await new LinearClient({ accessToken: token, apiUrl }).viewer;
    return { summary: `viewer=${viewer.id}` };
  };

/** Never touch api.linear.app from the role preflight in tests. */
const passPreflight = (): Preflight => async () => ({ skip: false });

/** A queue that is always reachable; `pending` messages are delivered on the next pulls. */
function queue(pending: AgentSessionEvent[] = []) {
  return async (url: string | URL | Request): Promise<Response> => {
    const next = String(url).endsWith("/messages/pull") ? pending.shift() : undefined;
    const result = next ? [{ receipt: "r-1", body: JSON.stringify(next) }] : [];
    return new Response(JSON.stringify({ result }), { status: 200 });
  };
}

function baseOptions(): Pick<OperatorOptions, "socketPath" | "registerSignals" | "queueEnv" | "queuePollIntervalMs" | "hmac"> {
  const dir = mkdtempSync(join(tmpdir(), "linearctl-remint-"));
  return {
    socketPath: join(dir, "operator.sock"),
    registerSignals: false,
    queueEnv: { CF_ACCOUNT_ID: "acct", CF_QUEUE_ID: "queue", CF_API_TOKEN: "cf-token-never-leak" },
    queuePollIntervalMs: 5,
    hmac: null,
  };
}

async function readyz(socketPath: string): Promise<Record<string, unknown>> {
  const res = await makeControlClient(socketPath).request("GET", "/readyz");
  return JSON.parse(res.body ?? "{}") as Record<string, unknown>;
}

async function waitFor(pred: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`waitFor: predicate did not become true within ${timeoutMs}ms`);
}

function runCheck(socketPath: string): Promise<number | null> {
  const child = spawn(process.execPath, ["run", "src/index.ts", "operator", "--check", "--socket", socketPath], {
    cwd: import.meta.dir.replace(/\/test$/, ""),
    stdio: ["ignore", "ignore", "ignore"],
  });
  const guard = setTimeout(() => child.kill("SIGKILL"), 12_000);
  return new Promise((resolve) => {
    child.on("exit", (code) => {
      clearTimeout(guard);
      resolve(code);
    });
  });
}

describe("operator token re-mint (CER-3309)", () => {
  test("a role run that gets Linear's 401 re-mints once, retries, and /readyz reports the fresh token", async () => {
    const linear = fakeLinear(new Set(["tok-fresh"]));
    const mint = sequenceMinter(["tok-expired", "tok-fresh"]);
    const handle = await startOperator({
      ...baseOptions(),
      tokenMinter: mint.minter,
      eventLoopRunner: async () => ({ thoughtId: "t", responseId: "r", movedToStateId: null }),
      queueFetcher: queue(),
      roles: [getRole("intake-triage")],
      roleRunners: { "intake-triage": viewerRunner(linear.url) },
      rolePreflight: passPreflight,
    });
    try {
      await waitFor(() => linear.seen.includes("tok-fresh"));
      expect(linear.seen.slice(0, 2)).toEqual(["tok-expired", "tok-fresh"]);
      expect(mint.mints()).toBe(2);

      await waitFor(async () => (await readyz(handle.socketPath)).lastPoll !== null);
      const body = await readyz(handle.socketPath);
      expect(body.ok).toBe(true);
      expect(body.auth).toBe("ok");
      expect(body.tokenMints).toBe(2);
      expect(body.tokenAgeSec).toBeLessThan(5);
      expect(JSON.stringify(body)).not.toContain("tok-");
      // Positive control for the not-ready case below: the same probe exits 0 here.
      expect(await runCheck(handle.socketPath)).toBe(0);
    } finally {
      await handle.shutdown();
      linear.stop();
    }
  });

  test("a queue event that gets Linear's 401 re-mints, and the next event uses the fresh token", async () => {
    const linear = fakeLinear(new Set(["tok-fresh"]));
    const mint = sequenceMinter(["tok-expired", "tok-fresh"]);
    const event = (id: string): AgentSessionEvent => ({
      type: "AgentSessionEvent",
      action: "created",
      promptContext: '<issue identifier="CER-3309"/>',
      agentSession: { id, issueId: "issue-1" },
    });
    const handle = await startOperator({
      ...baseOptions(),
      tokenMinter: mint.minter,
      eventLoopRunner: async (_event, token) => {
        await new LinearClient({ accessToken: token, apiUrl: linear.url }).viewer;
        return { thoughtId: "t", responseId: "r", movedToStateId: null };
      },
      queueFetcher: queue([event("session-1"), event("session-2")]),
    });
    try {
      await waitFor(() => linear.seen.length === 2);
      // The first event is acked (never retried, so it cannot post twice); the second uses the new token.
      expect(linear.seen).toEqual(["tok-expired", "tok-fresh"]);
      expect(mint.mints()).toBe(2);
    } finally {
      await handle.shutdown();
      linear.stop();
    }
  });

  test("a token Linear keeps rejecting makes the pod not-ready, with one re-mint and one retry per run", async () => {
    const linear = fakeLinear(new Set());
    const mint = sequenceMinter(["tok-revoked"]);
    const handle = await startOperator({
      ...baseOptions(),
      tokenMinter: mint.minter,
      eventLoopRunner: async () => ({ thoughtId: "t", responseId: "r", movedToStateId: null }),
      queueFetcher: queue(),
      roles: [getRole("intake-triage")],
      roleRunners: { "intake-triage": viewerRunner(linear.url) },
      rolePreflight: passPreflight,
    });
    try {
      await waitFor(() => linear.seen.length >= 2);
      await waitFor(async () => (await readyz(handle.socketPath)).lastPoll !== null);
      // Let the queue poller run many more cycles: the role cadence is minutes, so no further role calls may appear.
      await new Promise((r) => setTimeout(r, 100));
      expect(linear.seen).toEqual(["tok-revoked", "tok-revoked"]);
      expect(mint.mints()).toBe(2);

      const body = await readyz(handle.socketPath);
      expect(body.auth).toBe("failing");
      expect(body.ok).toBe(false);
      expect(await runCheck(handle.socketPath)).toBe(1);
    } finally {
      await handle.shutdown();
      linear.stop();
    }
  });
});
