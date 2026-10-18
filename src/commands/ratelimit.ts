import { CliError } from "../lib/errors.js";
import { apiKeyFromEnv } from "../client.js";
import { printJson } from "../lib/output.js";
import { fetchRateLimit, isExhausted, type RateLimitAxis } from "../core/ratelimit.js";

function renderAxis(name: string, a: RateLimitAxis): string {
  const budget =
    a.remaining !== null && a.limit !== null
      ? `${a.remaining} / ${a.limit} remaining`
      : "(headers not present)";
  const reset = a.resetAt ? `   resets ${a.resetAt}` : "";
  return `${name.padEnd(11)} ${budget}${reset}\n`;
}

export interface RatelimitOptions {
  json?: boolean;
}

/**
 * `linearctl ratelimit` — probe org-level API quota before a batch run (T18).
 * Exits 5 when either axis is exhausted so `&&`-chains abort cleanly.
 * See docs/spec.md §7 item 7.
 */
export async function ratelimit(opts: RatelimitOptions): Promise<void> {
  const info = await fetchRateLimit(apiKeyFromEnv());

  if (opts.json) {
    printJson(info);
  } else {
    process.stdout.write(
      renderAxis("requests", info.requests) + renderAxis("complexity", info.complexity),
    );
  }
  if (isExhausted(info)) throw new CliError("rate_limit", "Linear API quota exhausted.");
}
