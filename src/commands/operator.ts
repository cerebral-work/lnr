import { usageError } from "../lib/errors.js";
/**
 * `linearctl operator` — the long-running daemon subcommand (CER-1149 / CER-1188).
 *
 * Runs the operator core: mints a token at startup, polls the Cloudflare Queue
 * `linear-agent-events`, serves `linearctl watch`'s delegate-to-operator path
 * over a Unix socket (`POST /delegate`, `GET /healthz`), and (since CER-1188)
 * boots a set of maintainer-agent roles on D4 cadence. Stays in the foreground
 * until SIGINT/SIGTERM, which trigger graceful shutdown (stop polling, drain
 * in-flight events + role runs, close + unlink the socket).
 *
 *   `linearctl operator [--socket <path>] [--queue-poll-interval <ms>] [--role <name...>] [--json] [--check] [--health]`
 *
 * `--socket` overrides the default `~/.local/state/linearctl/run/operator.sock`.
 * `--role` repeats to boot roles from `src/core/role-catalog.ts` (e.g.
 * `--role intake-triage --role grooming`). Roles share the cached app-actor
 * token so actions attribute as the bot, not a user (D2).
 * `--json` suppresses the human banner (stderr) and emits the listening
 * address + booted roles as a single JSON line on stdout for machine consumption.
 *
 * The token value is never logged/echoed. Only redacted handles appear in
 * error messages, matching the `src/lib/secrets.ts` Secret pattern.
 *
 * `--check` does NOT start the daemon — it connects to a running operator's
 * Unix socket, GETs `/readyz`, prints the readiness report, and exits 0 if
 * ready / 1 if not (a drain on the runbook's step-7 smoke). CF env is reported
 * presence-only (never the values).
 *
 * `--health` (PR #120) does NOT start the daemon either — it connects to a
 * running operator's Unix socket, GETs `/healthz`, prints the liveness report
 * (uptime + queue depth), and exits 0 if alive / 1 if not. The cluster's
 * liveness probe uses this; readiness uses `--check` (`/readyz`). `--health`
 * and `--check` are mutually exclusive (an explicit error, not silent precedence).
 */

import { readFileSync } from "node:fs";
import { printJson } from "../lib/output.js";
import { DEFAULT_OPERATOR_SOCKET } from "../lib/control-socket.js";
import { checkOperator, healthOperator, parseTimeout } from "../lib/operator-probe.js";

export { checkOperator, healthOperator, parseTimeout };
import { startOperator, type OperatorOptions } from "../core/operator.js";
import {
  emitOperatorCrdsJson,
  emitOperatorCrdsYaml,
  reconcileCrManifestJson,
} from "../core/k8s-operator.js";
import { getRole, type RoleDescriptor, type RoleRunner } from "../core/role-catalog.js";
import { runIntakeTriage } from "../roles/intake-triage.js";
import { runGrooming } from "../roles/grooming.js";

export interface OperatorCommandOptions {
  /** Override the Unix socket path (default: ~/.local/state/linearctl/run/operator.sock). */
  socket?: string;
  /** Override the queue poll interval in ms. */
  queuePollInterval?: number;
  /** Role name(s) to boot on cadence (e.g. intake-triage, grooming). Repeatable. */
  role?: string[];
  /** Emit the listening address as JSON on stdout (suppresses the human banner). */
  json?: boolean;
  /** Don't start the daemon — probe a running operator's /readyz and exit 0/1 (Track 4). */
  check?: boolean;
  /** Don't start the daemon — probe a running operator's /healthz and exit 0/1 (PR #120 liveness). */
  health?: boolean;
  /** Probe connect timeout in ms (default: 1000, env: LINEARCTL_OPERATOR_TIMEOUT). */
  timeout?: number | string;
  /** Kubernetes namespace to watch/reconcile (default: linear-system). */
  namespace?: string;
  /** Emit CustomResourceDefinition manifests (YAML or JSON) and exit 0. */
  emitCrds?: boolean;
  /** Reconcile a single Custom Resource manifest from file or '-' for stdin and exit 0. */
  reconcile?: string;
}


function parsePollInterval(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw usageError(`--queue-poll-interval must be a positive number of milliseconds, got "${raw}"`);
  }
  return Math.floor(n);
}

/**
 * The default role-runner map: role name → handler. The first slice ships two
 * runners (intake-triage, grooming); later phases add the rest behind the LLM.
 * `--role` looks up names in the catalog, then resolves the handler here.
 */
const ROLE_RUNNERS: Record<string, RoleRunner> = {
  "intake-triage": runIntakeTriage,
  grooming: runGrooming,
};

/** Resolve `--role` names to descriptors + runners, throwing on a typo. */
function resolveRoles(
  names: string[] | undefined,
): { roles: RoleDescriptor[]; runners: Record<string, RoleRunner> } | undefined {
  if (!names?.length) return undefined;
  const roles: RoleDescriptor[] = [];
  const runners: Record<string, RoleRunner> = {};
  for (const name of names) {
    const role = getRole(name);
    roles.push(role);
    const runner = ROLE_RUNNERS[name];
    if (!runner) {
      throw new Error(
        `role "${name}" is registered but has no runner implementation (first slice: intake-triage, grooming)`,
      );
    }
    runners[name] = runner;
  }
  return { roles, runners };
}

/**
 * `linearctl operator [--socket <path>] [--queue-poll-interval <ms>] [--role <name...>] [--namespace <ns>] [--emit-crds] [--reconcile <file|->] [--json] [--check] [--health]`.
 *
 * Starts the daemon and blocks until SIGINT/SIGTERM. The banner goes to
 * stderr so stdout stays clean for `--json` machine output. `--check` short-
 * circuits: it probes a running operator's `/readyz` and exits 0/1 instead of
 * starting a new daemon. `--health` (PR #120) likewise short-circuits to probe
 * `/healthz`; the two are mutually exclusive.
 */
export async function operator(opts: OperatorCommandOptions): Promise<void> {
  if (opts.emitCrds) {
    if (opts.json) {
      printJson(emitOperatorCrdsJson());
    } else {
      process.stdout.write(emitOperatorCrdsYaml());
    }
    return;
  }

  const namespace = opts.namespace ?? "linear-system";

  if (opts.reconcile) {
    const raw =
      opts.reconcile === "-"
        ? readFileSync(0, "utf8")
        : readFileSync(opts.reconcile, "utf8");
    const reconciled = reconcileCrManifestJson(raw);
    if (opts.json) {
      printJson(reconciled);
    } else {
      const meta = (reconciled.metadata ?? {}) as Record<string, unknown>;
      process.stdout.write(
        `Reconciled ${String(reconciled.kind ?? "CR")}/${String(meta.name ?? "unnamed")} in namespace ${namespace}\n`,
      );
    }
    return;
  }

  // --health and --check are mutually exclusive — the liveness vs readiness
  // probes must not be conflated. An explicit error beats silent precedence.
  if (opts.health && opts.check) {
    throw usageError(
      "linearctl operator: --health and --check are mutually exclusive " +
        "(--health probes /healthz for liveness, --check probes /readyz for readiness).",
    );
  }

  const timeoutMs = parseTimeout(opts.timeout);

  // --health: probe liveness (/healthz), don't start the daemon.
  if (opts.health) {
    await healthOperator(opts.socket ?? DEFAULT_OPERATOR_SOCKET, opts.json, timeoutMs);
    return;
  }

  // --check: probe readiness (/readyz), don't start the daemon.
  if (opts.check) {
    await checkOperator(opts.socket ?? DEFAULT_OPERATOR_SOCKET, opts.json, timeoutMs);
    return;
  }

  const resolved = resolveRoles(opts.role);

  const operatorOpts: OperatorOptions = {
    socketPath: opts.socket ?? DEFAULT_OPERATOR_SOCKET,
    queuePollIntervalMs: parsePollInterval(opts.queuePollInterval?.toString()),
    ...(resolved ? { roles: resolved.roles, roleRunners: resolved.runners } : {}),
  };

  const handle = await startOperator(operatorOpts);

  if (opts.json) {
    printJson({
      ok: true,
      namespace,
      socket: handle.socketPath,
      polling: handle.polling,
      roles: handle.roles,
    });
  } else {
    process.stderr.write(
      `linearctl operator listening on ${handle.socketPath} (namespace: ${namespace})\n` +
        `  polling: ${handle.polling ? "on" : "off (set CF_ACCOUNT_ID/CF_QUEUE_ID/CF_API_TOKEN to enable)"}\n` +
        `  roles:   ${handle.roles.length ? handle.roles.join(", ") : "none (use --role <name>)"}\n` +
        `  stop:   SIGINT / SIGTERM\n`,
    );
  }

  // Block until the process is killed (startOperator wired the signal handlers).
  // `startOperator`'s shutdown handler calls process.exit(0); we just hold here.
  return new Promise(() => {});
}
