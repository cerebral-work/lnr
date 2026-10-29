import type { LinearClient } from "@linear/sdk";

type St = { id: string; name: string; type: string };
export const STATES: St[] = [
  { id: "s-triage", name: "Triage", type: "triage" },
  { id: "s-backlog", name: "Backlog", type: "backlog" },
  { id: "s-todo", name: "Todo", type: "unstarted" },
  { id: "s-prog", name: "In Progress", type: "started" },
  { id: "s-rev", name: "In Review", type: "started" },
  { id: "s-done", name: "Done", type: "completed" },
  { id: "s-canc", name: "Canceled", type: "canceled" },
  { id: "s-dup", name: "Duplicate", type: "duplicate" },
];
const byName = (n: string) => STATES.find((s) => s.name === n)!;

export interface Row { identifier: string; title: string; state: string; parent?: string }
export interface StubOpts {
  rows: Row[];
  pageSize?: number;
  noReview?: boolean;
  commentFails?: boolean;
  failUpdateFor?: string;
  failAttach?: boolean;
  /** Make every issue read throw once a state update has happened. */
  failReadAfterUpdate?: boolean;
}

/** In-memory Linear: one live store behind rawRequest (reads) and the SDK slice (writes). */
export function stub(o: StubOpts) {
  const calls: string[] = [];
  const store = new Map(o.rows.map((r) => [r.identifier, { ...r }]));
  const states = o.noReview ? STATES.filter((s) => s.name !== "In Review") : STATES;
  const node = (id: string) => {
    const r = store.get(id)!;
    const st = byName(r.state);
    return { id: `uuid-${r.identifier}`, identifier: r.identifier, title: r.title, url: `https://linear.app/x/${r.identifier}`,
      team: { id: "team-1", key: "CER" }, state: st, parent: r.parent ? { id: `uuid-${r.parent}`, identifier: r.parent } : null };
  };
  const rawRequest = async (query: string, vars: any) => {
    if (query.includes("query LifecycleIssue")) {
      if (o.failReadAfterUpdate && calls.some((c) => c.startsWith("update:"))) throw new Error("read boom");
      calls.push(`read:${vars.id}`);
      return { data: { issue: store.has(vars.id) ? node(vars.id) : null } };
    }
    if (query.includes("query LifecycleChildren")) {
      calls.push(`children:${vars.id}`);
      const all = [...store.values()].filter((r) => r.parent === vars.id).map((r) => ({ ...node(r.identifier) }));
      const size = o.pageSize ?? 50;
      const start = vars.after ? Number(vars.after) : 0;
      const nodes = all.slice(start, start + size);
      const next = start + size;
      return { data: { issue: { children: { nodes, pageInfo: { hasNextPage: next < all.length, endCursor: next < all.length ? String(next) : null } } } } };
    }
    throw new Error(`unexpected query ${query}`);
  };
  const sdkIssue = (ref: string) => {
    const key = ref.startsWith("uuid-") ? ref.slice(5) : ref;
    const n = node(key);
    return { id: n.id, identifier: n.identifier, url: n.url, team: Promise.resolve({ id: "team-1", key: "CER" }) };
  };
  const client = {
    client: { rawRequest },
    issue: async (ref: string) => sdkIssue(ref),
    workflowStates: async () => ({ nodes: states }),
    createComment: async ({ issueId, body }: any) => {
      calls.push(`comment:${issueId.slice(5)}`);
      if (o.commentFails) throw new Error("comment boom");
      (client as any).bodies.push({ issueId: issueId.slice(5), body });
      return { success: true, comment: Promise.resolve({ id: "c1" }) };
    },
    createAttachment: async ({ issueId, url }: any) => {
      calls.push(`attach:${issueId.slice(5)}:${url}`);
      if (o.failAttach) throw new Error("attach boom");
      return { success: true };
    },
    updateIssue: async (uuid: string, input: { stateId: string }) => {
      const id = uuid.slice(5);
      calls.push(`update:${id}:${states.find((s) => s.id === input.stateId)!.name}`);
      if (o.failUpdateFor === id) return { success: false };
      store.get(id)!.state = states.find((s) => s.id === input.stateId)!.name;
      return { success: true, issue: Promise.resolve({ ...sdkIssue(id), title: store.get(id)!.title, state: Promise.resolve(byName(store.get(id)!.state)), assignee: Promise.resolve(null) }) };
    },
    bodies: [] as Array<{ issueId: string; body: string }>,
  };
  return { client: client as unknown as LinearClient, raw: client, calls, store };
}
export const writes = (calls: string[]) => calls.filter((c) => /^(comment|update|attach):/.test(c));
export const noRemote = { originRemote: () => undefined };

export const family = (child: string[] = ["Todo", "Todo"]): Row[] => [
  { identifier: "CER-1", title: "parent", state: "In Progress" },
  ...child.map((s, i) => ({ identifier: `CER-${i + 2}`, title: `child ${i + 2}`, state: s, parent: "CER-1" })),
];

