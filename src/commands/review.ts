import type { LinearClient } from "@linear/sdk";
import { makeClient } from "../client.js";
import { reviewIssue } from "../core/lifecycle.js";
import { printJson } from "../lib/output.js";
import { withSpinner } from "../lib/spinner.js";

export interface ReviewCmdOptions {
  pr?: string;
  repo?: string;
  rollup?: boolean;
  json?: boolean;
}

/**
 * `linearctl review <id> [--pr] [--repo] [--rollup]` — move the issue to the
 * team's In Review state (started-type In Progress if there is none), attach
 * the PR, optionally roll the parent up. Delegates to `core.reviewIssue`.
 */
export async function review(id: string, opts: ReviewCmdOptions, injected?: LinearClient): Promise<void> {
  const client = injected ?? makeClient();
  const result = await withSpinner(`Moving ${id} to review…`, () => reviewIssue(client, id, opts));
  if (result.error || result.rollupError) process.exitCode = 1;
  if (opts.json) {
    printJson(result);
    return;
  }
  process.stdout.write(`${result.identifier} [${result.state}]: ${result.title}\n  url: ${result.url}\n`);
  if (result.prUrl) process.stdout.write(`  attached: ${result.prUrl}\n`);
  if (result.rolledUpParent) process.stdout.write(`  rolled up: ${result.rolledUpParent.identifier} [${result.rolledUpParent.state}]\n`);
  if (result.error) process.stderr.write(`error: ${result.error}\n`);
  if (result.rollupError) process.stderr.write(`error: rollup failed (child move stands): ${result.rollupError}\n`);
}
