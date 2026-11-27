/**
 * Operator probes: `linearctl operator --check` (GET /readyz) and
 * `linearctl operator --health` (GET /healthz) over the daemon's Unix socket.
 *
 * This module imports only the control-socket client and node built-ins, so
 * `src/main.ts` can answer the kubelet exec probes without loading the full
 * CLI bundle. Loading the bundle cost about 0.2 s CPU and 55 MB of memory per
 * probe, charged to the pod's limits (CER-4207). Keep it free of heavy imports.
 */
import { usageError } from "./errors.js";
import { DEFAULT_OPERATOR_SOCKET, makeControlClient } from "./control-socket.js";

/** The parsed /readyz report body (presence-only — no secret values). */
export interface ReadyzReport {
  ok: boolean;
  cfEnv: { accountId: boolean; queueId: boolean; apiToken: boolean };
  tokenAgeSec: number;
  /** Successful token mints since start (CER-3309). Absent from older daemons. */
  tokenMints?: number;
  /** "failing" while Linear rejects fresh tokens (CER-3309). Absent from older daemons. */
  auth?: "ok" | "failing";
  lastPoll: string | null;
  queueDepth: number;
}

/** The parsed /healthz report body (PR #120 liveness — uptime + queue depth). */
export interface HealthReport {
  ok: boolean;
  uptime: number;
  queueDepth: number;
}

export function parseTimeout(raw: string | number | undefined): number {
  const envVal = process.env.LINEARCTL_OPERATOR_TIMEOUT;
  const target = raw !== undefined ? raw : envVal;
  if (target === undefined || target === "") return 1000;
  const n = Number(target);
  if (!Number.isFinite(n) || n <= 0) {
    throw usageError(`--timeout must be a positive number of milliseconds, got "${target}"`);
  }
  return Math.floor(n);
}

/**
 * Probe a running operator's `/readyz` over the Unix socket + report.
 *
 * Print the readiness report (presence-only CF env, token age, last poll,
 * queue depth) and exit 0 if the daemon is ready to consume / 1 otherwise.
 * A connection failure (no daemon, socket stale) is a not-ready result with a
 * diagnostic on stderr — it is NOT a thrown exception, so the runbook's step-7
 * smoke gets a clean exit code rather than a stack trace.
 *
 * `--json` prints the raw /readyz body as JSON; the default prints a human report.
 */
export async function checkOperator(
  socketPath: string,
  json?: boolean,
  timeoutMs: number = 1000,
): Promise<void> {
  let report: ReadyzReport;
  try {
    const client = makeControlClient(socketPath, { connectTimeoutMs: timeoutMs });
    const res = await client.request("GET", "/readyz");
    if (res.status !== 200) {
      throw new Error(`operator --check: /readyz returned HTTP ${res.status}`);
    }
    report = JSON.parse(res.body ?? "") as ReadyzReport;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`operator --check: not ready — ${msg}`);
  }

  if (json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    const cf = report.cfEnv;
    process.stdout.write(
      `operator readiness: ${report.ok ? "READY" : "NOT READY"}\n` +
        `  cf env: accountId=${cf.accountId} queueId=${cf.queueId} apiToken=${cf.apiToken}\n` +
        `  token age: ${report.tokenAgeSec}s\n` +
        (report.auth !== undefined ? `  linear auth: ${report.auth} (mints: ${report.tokenMints ?? "?"})\n` : "") +
        `  last poll: ${report.lastPoll ?? "(never)"}\n` +
        `  queue depth: ${report.queueDepth}\n`,
    );
  }
  if (!report.ok) throw new Error("operator probe reported unhealthy; inspect the report on stdout.");
}

/**
 * Probe a running operator's `/healthz` over the Unix socket + report (PR #120).
 *
 * Liveness probe: "is the process alive?" — distinct from `--check`'s
 * "is it able to consume?" readiness. Prints the liveness report (uptime +
 * queue depth) and exits 0 if the daemon is alive / 1 otherwise. A connection
 * failure (no daemon, socket stale) is a not-alive result with a diagnostic on
 * stderr — not a thrown exception — so the kubelet exec liveness probe gets a
 * clean exit code rather than a stack trace.
 *
 * `--json` prints the raw /healthz body as JSON; the default prints a human report.
 */
export async function healthOperator(
  socketPath: string,
  json?: boolean,
  timeoutMs: number = 1000,
): Promise<void> {
  let report: HealthReport;
  try {
    const client = makeControlClient(socketPath, { connectTimeoutMs: timeoutMs });
    const res = await client.request("GET", "/healthz");
    if (res.status !== 200) {
      throw new Error(`operator --health: /healthz returned HTTP ${res.status}`);
    }
    report = JSON.parse(res.body ?? "") as HealthReport;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`operator --health: not alive — ${msg}`);
  }

  if (json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    process.stdout.write(
      `operator liveness: ${report.ok ? "ALIVE" : "NOT ALIVE"}\n` +
        `  uptime: ${report.uptime}s\n` +
        `  queue depth: ${report.queueDepth}\n`,
    );
  }
  if (!report.ok) throw new Error("operator probe reported unhealthy; inspect the report on stdout.");
}

export type ProbeKind = "health" | "check";

export interface ProbeArgs {
  kind: ProbeKind;
  socket: string;
  json: boolean;
  timeout?: string;
}

/**
 * Recognise exactly the probe forms of `operator`: one of `--health` or
 * `--check`, plus optional `--json`, `--socket <path>` and `--timeout <ms>`.
 * Any other token, a repeated flag, or both probe flags returns null, and the
 * caller hands the arguments to the full CLI, which keeps its own parsing and
 * error messages for those cases.
 */
export function parseProbeArgs(argv: readonly string[]): ProbeArgs | null {
  if (argv[0] !== "operator") return null;
  let kind: ProbeKind | undefined;
  let socket: string | undefined;
  let timeout: string | undefined;
  let json = false;
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--health" || arg === "--check") {
      if (kind !== undefined) return null;
      kind = arg === "--health" ? "health" : "check";
    } else if (arg === "--json") {
      if (json) return null;
      json = true;
    } else if (arg === "--socket" || arg === "--timeout") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("-")) return null;
      if (arg === "--socket") {
        if (socket !== undefined) return null;
        socket = value;
      } else {
        if (timeout !== undefined) return null;
        timeout = value;
      }
      i++;
    } else {
      return null;
    }
  }
  if (kind === undefined) return null;
  return { kind, socket: socket ?? DEFAULT_OPERATOR_SOCKET, json, ...(timeout !== undefined ? { timeout } : {}) };
}

/** Run one probe and return the process exit code: 0 healthy, 1 not, 2 usage. */
export async function runProbe(args: ProbeArgs): Promise<number> {
  try {
    const timeoutMs = parseTimeout(args.timeout);
    if (args.kind === "health") await healthOperator(args.socket, args.json, timeoutMs);
    else await checkOperator(args.socket, args.json, timeoutMs);
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`linearctl: ${msg}\n`);
    return (err as { code?: unknown }).code === 2 ? 2 : 1;
  }
}
