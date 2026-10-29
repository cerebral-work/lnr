import type { LinearClient } from "@linear/sdk";
import { notFoundError } from "../lib/errors.js";
import { withRetry } from "../lib/retry.js";

export interface ChildIssue {
  identifier: string;
  title: string;
  state: string;
  stateType: string;
}

export interface SubtaskSummary {
  total: number;
  completed: number;
  canceled: number;
  duplicate: number;
  open: number;
  allCompleted: boolean;
}

interface ChildrenData {
  issue: {
    children: {
      nodes: Array<{ identifier: string; title: string; state: { name: string; type: string } | null }>;
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
  } | null;
}

const CHILDREN = `query LifecycleChildren($id: String!, $after: String) {
  issue(id: $id) { children(first: 50, after: $after) {
    nodes { identifier title state { name type } } pageInfo { hasNextPage endCursor }
  } }
}`;

/** A state type that ends the work (completed, canceled, duplicate): anything else (Triage and Backlog included) is open. */
export const isClosedType = (stateType: string): boolean => stateType === "completed" || stateType === "canceled" || stateType === "duplicate";

/**
 * Read every child of an issue LIVE from the API (raw GraphQL, never the SQLite
 * cache), following pagination to the end.
 */
export async function listChildren(client: LinearClient, ref: string): Promise<ChildIssue[]> {
  const out: ChildIssue[] = [];
  let after: string | null = null;
  const cursors = new Set<string>();
  for (;;) {
    const cursor: string | null = after;
    const res: { data?: ChildrenData } = await withRetry(() =>
      client.client.rawRequest<ChildrenData, Record<string, unknown>>(CHILDREN, { id: ref, after: cursor }),
    );
    const issue = res.data?.issue;
    if (!issue) throw notFoundError(`${ref}: issue not found.`);
    for (const n of issue.children.nodes) {
      out.push({ identifier: n.identifier, title: n.title, state: n.state?.name ?? "", stateType: n.state?.type ?? "" });
    }
    if (!issue.children.pageInfo.hasNextPage || !issue.children.pageInfo.endCursor) return out;
    if (cursors.has(issue.children.pageInfo.endCursor)) throw new Error(`${ref}: children pagination did not advance.`);
    cursors.add(issue.children.pageInfo.endCursor);
    after = issue.children.pageInfo.endCursor;
  }
}

export function summarizeChildren(children: ChildIssue[]): SubtaskSummary {
  const completed = children.filter((c) => c.stateType === "completed").length;
  const canceled = children.filter((c) => c.stateType === "canceled").length;
  const duplicate = children.filter((c) => c.stateType === "duplicate").length;
  const open = children.length - completed - canceled - duplicate;
  return { total: children.length, completed, canceled, duplicate, open, allCompleted: open === 0 };
}
