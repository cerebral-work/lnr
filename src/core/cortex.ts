import { execFile } from "node:child_process";
import { CliError } from "../lib/errors.js";

/** Cortex spec 0036's hard response ceiling; do not inflate agent context. */
export const CORTEX_MAX_BYTES = 131_072;

/** Observe a checkout through Cortex's own TOCTOU-checked adapter. Never sends. */
export async function cortexRepoQuery(directory?: string): Promise<Record<string, unknown>> {
  const env = { ...process.env };
  delete env.LINEAR_API_KEY;
  const output = await new Promise<string>((resolve, reject) => {
    execFile("cortex", ["repo-query", "--json", "--max-patch-bytes", "0"], {
      cwd: directory,
      env,
      timeout: 5_000,
      maxBuffer: CORTEX_MAX_BYTES,
      encoding: "utf8",
    }, (error, stdout) => {
      if (error) reject(new CliError("other", "Cortex repository observation failed.",
        "Check that cortex is installed and the directory is a Git checkout."));
      else resolve(stdout);
    });
  });
  let report: Record<string, unknown>;
  try { report = JSON.parse(output); }
  catch { throw new CliError("other", "Cortex returned invalid JSON."); }
  if (!report || report.document_type !== "cortex-resident-repo-query" ||
      report.schema_version !== 1 || report.authority !== "observation_only") {
    throw new CliError("refused", "Unsupported Cortex repository observation contract.");
  }
  return report;
}
