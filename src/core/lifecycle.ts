import { execFileSync } from "node:child_process";
import type { LinearClient } from "@linear/sdk";
import { refusedError, usageError, notFoundError } from "../lib/errors.js";
import { withRetry } from "../lib/retry.js";
import { attachLink, closeIssue, createComment, updateIssue } from "./issues.js";
import { isClosedType, listChildren, type ChildIssue } from "./children.js";

export { listChildren } from "./children.js";

export interface LifecycleDeps {
  /** URL of the cwd git remote `origin`, or undefined when there is none. */
  originRemote?: () => string | undefined;
}

export interface PrRef {
  url: string;
  repo: string;
  number: number;
}

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const PR_URL_RE = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)\/?$/;
const REMOTE_RES = [
  /^git@github\.com:([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/,
  /^(?:ssh:\/\/git@|https:\/\/(?:[^@/]+@)?)github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/,
];

function gitOriginRemote(): string | undefined {
  try {
    return execFileSync("git", ["remote", "get-url", "origin"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Turn `--pr <number-or-url>` into a PR URL. A bare number needs `--repo` or a
 * GitHub `origin` remote; anything else is a usage error. Never guesses.
 */
export function resolvePrRef(pr: string, repo: string | undefined, originRemote: () => string | undefined): PrRef {
  const full = PR_URL_RE.exec(pr.trim());
  if (full) {
    if (repo !== undefined && repo.trim().toLowerCase() !== full[1].toLowerCase()) throw usageError(`--repo ${JSON.stringify(repo)} conflicts with the PR URL's repo ${full[1]}.`);
    return { url: `https://github.com/${full[1]}/pull/${full[2]}`, repo: full[1], number: Number(full[2]) };
  }
  const num = /^#?(\d+)$/.exec(pr.trim());
  if (!num) throw usageError(`--pr ${JSON.stringify(pr)} is neither a PR number nor a https://github.com/<owner>/<repo>/pull/<n> URL.`);
  let resolved = repo?.trim();
  if (resolved !== undefined && !REPO_RE.test(resolved)) throw usageError(`--repo ${JSON.stringify(repo)} must be <owner>/<repo>.`);
  if (!resolved) {
    const remote = originRemote();
    for (const re of REMOTE_RES) {
      const m = remote ? re.exec(remote) : null;
      if (m) { resolved = m[1]; break; }
    }
  }
  if (!resolved) throw usageError(`--pr ${num[1]} needs --repo <owner/repo>: the cwd git remote "origin" is missing or not a GitHub remote.`);
  return { url: `https://github.com/${resolved}/pull/${num[1]}`, repo: resolved, number: Number(num[1]) };
}

interface IssueRead {
  id: string;
  identifier: string;
  title: string;
  url: string;
  teamId: string;
  state: string;
  stateType: string;
  parent: string | null;
}

const ISSUE = `query LifecycleIssue($id: String!) {
  issue(id: $id) { id identifier title url team { id } state { name type } parent { identifier } }
}`;

/** Live issue read (raw GraphQL; the SQLite cache is never consulted). */
async function readIssue(client: LinearClient, ref: string): Promise<IssueRead> {
  const res = await withRetry(() =>
    client.client.rawRequest<{ issue: { id: string; identifier: string; title: string; url: string; team: { id: string } | null; state: { name: string; type: string } | null; parent: { identifier: string } | null } | null }, Record<string, unknown>>(ISSUE, { id: ref }),
  );
  const i = res.data?.issue;
  if (!i) throw notFoundError(`${ref}: issue not found.`);
  if (!i.team) throw notFoundError(`${i.identifier}: issue has no team.`);
  return { id: i.id, identifier: i.identifier, title: i.title, url: i.url, teamId: i.team.id, state: i.state?.name ?? "", stateType: i.state?.type ?? "", parent: i.parent?.identifier ?? null };
}

const list = (kids: ChildIssue[]) => kids.map((c) => `${c.identifier} [${c.state}] ${c.title}`);

export interface CloseEvidenceOptions {
  commit?: string;
  pr?: string;
  repo?: string;
  comment?: string;
  rollup?: boolean;
  force?: boolean;
  duplicateOf?: string;
}

/** Flag combinations that must fail before any API call. */
export function validateCloseOptions(o: CloseEvidenceOptions): void {
  if (o.duplicateOf === undefined) return;
  const clash = (["commit", "pr", "rollup", "comment"] as const).filter((k) => o[k] !== undefined && o[k] !== false);
  if (clash.length) throw usageError(`--duplicate-of cannot be combined with ${clash.map((k) => `--${k}`).join(", ")}.`);
}

export interface CloseResult {
  id: string;
  identifier: string;
  title: string;
  url: string;
  state: string;
  stateType: string;
  closed: boolean;
  flipped: boolean;
  commentPosted: boolean;
  prUrl?: string;
  commit?: string;
  rolledUpParent?: { identifier: string; state: string } | null;
  rollupError?: string;
  error?: string;
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0];

function receiptBody(o: CloseEvidenceOptions, pr: PrRef | undefined, repo: string | undefined): string {
  const lines = ["Shipped."];
  if (o.commit) {
    lines.push(`- Commit: \`${o.commit}\`${repo ? ` (https://github.com/${repo}/commit/${o.commit})` : ""}`);
  }
  if (pr) lines.push(`- PR: ${pr.url}`);
  if (o.comment) lines.push("", o.comment);
  return lines.join("\n");
}

/**
 * Close with evidence: guard, receipt comment, state flip, live re-read, optional
 * parent rollup. The comment always lands before the flip; a failed comment
 * throws with the issue untouched.
 */
export async function closeWithEvidence(client: LinearClient, ref: string, opts: CloseEvidenceOptions, deps: LifecycleDeps = {}): Promise<CloseResult> {
  validateCloseOptions(opts);
  const pr = opts.pr ? resolvePrRef(opts.pr, opts.repo, deps.originRemote ?? gitOriginRemote) : undefined;
  const repo = pr?.repo ?? opts.repo;
  const before = await readIssue(client, ref);

  if (!opts.force) {
    const open = (await listChildren(client, before.identifier)).filter((c) => !isClosedType(c.stateType));
    if (open.length) {
      throw refusedError(`${before.identifier} has ${open.length} open child issue(s):\n  ${list(open).join("\n  ")}`, "Close or cancel them first, or pass --force.");
    }
  }

  const hasEvidence = Boolean(opts.commit || pr || opts.comment);
  if (hasEvidence) await createComment(client, before.identifier, receiptBody(opts, pr, repo));

  const base = { id: before.id, identifier: before.identifier, title: before.title, url: before.url, commentPosted: hasEvidence, ...(pr ? { prUrl: pr.url } : {}), ...(opts.commit ? { commit: opts.commit } : {}) };
  try {
    await closeIssue(client, before.identifier);
  } catch (e) {
    return { ...base, state: before.state, stateType: before.stateType, closed: false, flipped: false, error: `state flip failed after the comment was posted: ${msg(e)}` };
  }

  let after: IssueRead;
  try {
    after = await readIssue(client, before.identifier);
  } catch (e) {
    return { ...base, state: before.state, stateType: before.stateType, closed: false, flipped: true, error: `state was flipped but the re-read failed: ${msg(e)}` };
  }
  const result: CloseResult = { ...base, state: after.state, stateType: after.stateType, flipped: true, closed: after.stateType === "completed" };
  if (!result.closed) {
    result.error = `re-read shows ${after.identifier} in ${JSON.stringify(after.state)} (${after.stateType}), not completed.`;
    return result;
  }
  if (opts.rollup) {
    try {
      result.rolledUpParent = await rollupClose(client, after);
    } catch (e) {
      result.rollupError = msg(e);
    }
  }
  return result;
}

/** Close the parent when every sibling (live read) is completed or canceled. */
async function rollupClose(client: LinearClient, child: IssueRead): Promise<{ identifier: string; state: string } | null> {
  if (!child.parent) return null;
  const siblings = await listChildren(client, child.parent);
  if (!siblings.every((s) => isClosedType(s.stateType))) return null;
  const parent = await readIssue(client, child.parent);
  if (isClosedType(parent.stateType)) return null;
  await createComment(client, parent.identifier, `All ${siblings.length} subtask(s) are closed (last: ${child.identifier}). Closing the parent.\n\n${list(siblings).map((l) => `- ${l}`).join("\n")}`);
  await closeIssue(client, parent.identifier);
  const reread = await readIssue(client, parent.identifier);
  if (reread.stateType !== "completed") throw new Error(`${parent.identifier} re-read in ${JSON.stringify(reread.state)}, not completed.`);
  return { identifier: reread.identifier, state: reread.state };
}

export interface ReviewOptions {
  pr?: string;
  repo?: string;
  rollup?: boolean;
}

export interface ReviewResult {
  identifier: string;
  title: string;
  url: string;
  state: string;
  stateType: string;
  moved: boolean;
  prUrl?: string;
  attached?: boolean;
  rolledUpParent?: { identifier: string; state: string } | null;
  error?: string;
  rollupError?: string;
}

const IN_REVIEW = /^in[\s-]?review$/i;

/** The team's "In Review" state, else its started-type "In Progress", else any started state. */
async function reviewStateName(client: LinearClient, teamId: string): Promise<string> {
  const states = (await client.workflowStates({ filter: { team: { id: { eq: teamId } } } })).nodes;
  const pick = states.find((s) => IN_REVIEW.test(s.name))
    ?? states.find((s) => s.type === "started" && /in[\s-]?progress/i.test(s.name))
    ?? states.find((s) => s.type === "started");
  if (!pick) throw notFoundError("no In Review or started workflow state found for this team.");
  return pick.name;
}

/** Move to In Review, attach the PR, optionally roll the parent up. */
export async function reviewIssue(client: LinearClient, ref: string, opts: ReviewOptions, deps: LifecycleDeps = {}): Promise<ReviewResult> {
  const pr = opts.pr ? resolvePrRef(opts.pr, opts.repo, deps.originRemote ?? gitOriginRemote) : undefined;
  const before = await readIssue(client, ref);
  await updateIssue(client, before.identifier, { state: await reviewStateName(client, before.teamId) });
  let error: string | undefined;
  if (pr) {
    try {
      await attachLink(client, before.identifier, pr.url, `PR #${pr.number}`);
    } catch (e) {
      error = `state moved but the PR attach failed: ${msg(e)}`;
    }
  }
  let after: IssueRead;
  try {
    after = await readIssue(client, before.identifier);
  } catch (e) {
    return { identifier: before.identifier, title: before.title, url: before.url, state: before.state, stateType: before.stateType, moved: true, ...(pr ? { prUrl: pr.url, attached: !error } : {}), error: error ?? `state moved but the re-read failed: ${msg(e)}` };
  }
  const result: ReviewResult = { identifier: after.identifier, title: after.title, url: after.url, state: after.state, stateType: after.stateType, moved: true, ...(pr ? { prUrl: pr.url, attached: !error } : {}), ...(error ? { error } : {}) };
  if (opts.rollup) {
    result.rolledUpParent = null;
    try {
      if (after.parent) {
        const siblings = await listChildren(client, after.parent);
        if (siblings.every((s) => isClosedType(s.stateType) || IN_REVIEW.test(s.state))) {
          const parent = await readIssue(client, after.parent);
          if (!isClosedType(parent.stateType) && !IN_REVIEW.test(parent.state)) {
            await updateIssue(client, parent.identifier, { state: await reviewStateName(client, parent.teamId) });
            const moved = await readIssue(client, parent.identifier);
            result.rolledUpParent = { identifier: moved.identifier, state: moved.state };
          }
        }
      }
    } catch (e) {
      result.rollupError = msg(e);
    }
  }
  return result;
}
