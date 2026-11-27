/**
 * Entry point of the compiled `lnr` / `linearctl` binary.
 *
 * The kubelet runs `linearctl operator --health` and `operator --check` as exec
 * probes every few seconds. Loading the full CLI for each one cost about 0.2 s
 * CPU and 55 MB of memory, charged to the operator pod's limits (CER-4207).
 * Those two probe forms are answered here from the light probe module; every
 * other invocation loads the full CLI from `index.ts` unchanged.
 */
import { parseProbeArgs, runProbe } from "./lib/operator-probe.js";

const probe = parseProbeArgs(process.argv.slice(2));
if (probe) {
  process.exitCode = await runProbe(probe);
} else {
  await import("./index.js");
}
