import { describe, expect, test } from "bun:test";
import type { LinearClient } from "@linear/sdk";
import { getIssue, renderIssueDetail, type IssueDetail } from "../src/core/issues.js";

/** Stub the slice of the SDK's lazy-resolving Issue that getIssue touches. */
function stubClient(overrides: Record<string, unknown> = {}): LinearClient {
  const issue = {
    id: "uuid-1",
    identifier: "CER-1406",
    title: "Chunk-embedder swap",
    url: "https://linear.app/x/issue/CER-1406",
    description: "## What\nRoute chunk vectors through EmbedderClient.",
    priority: 2,
    priorityLabel: "High",
    createdAt: new Date("2026-06-20T10:00:00Z"),
    updatedAt: new Date("2026-07-01T09:00:00Z"),
    state: Promise.resolve({ name: "In Progress", type: "started" }),
    assignee: Promise.resolve({ displayName: "aria" }),
    project: Promise.resolve({ name: "reverie-cloud platform prereqs" }),
    parent: Promise.resolve(undefined),
    labels: () => Promise.resolve({ nodes: [{ name: "store" }, { name: "M3" }] }),
    comments: () =>
      Promise.resolve({
        nodes: [
          {
            id: "cm1",
            body: "Verified live",
            url: "https://linear.app/x/issue/CER-1406#comment-cm1",
            createdAt: new Date("2026-07-02T08:00:00Z"),
          },
        ],
        pageInfo: { hasNextPage: false, endCursor: null },
      }),
    ...overrides,
  };
  const rawRequest = async () => ({ data: { issue: { children: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } });
  return { issue: () => Promise.resolve(issue), client: { rawRequest } } as unknown as LinearClient;
}

describe("getIssue", () => {
  test("assembles full detail from the lazy SDK issue", async () => {
    const detail = await getIssue(stubClient(), "CER-1406");
    expect(detail).toEqual({
      id: "uuid-1",
      identifier: "CER-1406",
      title: "Chunk-embedder swap",
      url: "https://linear.app/x/issue/CER-1406",
      state: "In Progress",
      stateType: "started",
      assignee: "aria",
      priority: "High",
      project: "reverie-cloud platform prereqs",
      milestone: null,
      labels: ["store", "M3"],
      parent: null,
      description: "## What\nRoute chunk vectors through EmbedderClient.",
      createdAt: "2026-06-20T10:00:00.000Z",
      updatedAt: "2026-07-01T09:00:00.000Z",
      children: [],
      subtaskSummary: { total: 0, completed: 0, canceled: 0, duplicate: 0, open: 0, allCompleted: true },
      comments: {
        nodes: [
          {
            id: "cm1",
            body: "Verified live",
            url: "https://linear.app/x/issue/CER-1406#comment-cm1",
            createdAt: "2026-07-02T08:00:00.000Z",
          },
        ],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    });
  });

  test("carries comments so a post-write read-back sees them", async () => {
    const detail = await getIssue(stubClient(), "CER-1406");
    expect(detail.comments?.nodes.map((c) => c.body)).toEqual(["Verified live"]);
    const out = renderIssueDetail(detail);
    expect(out).toContain("comments: 1");
    expect(out).toContain("Verified live");
    const empty = await getIssue(
      stubClient({ comments: () => Promise.resolve({ nodes: [], pageInfo: { hasNextPage: false, endCursor: null } }) }),
      "CER-1406",
    );
    expect(renderIssueDetail(empty)).not.toContain("comments:");
  });

  test("includes milestone identity and date for post-write verification", async () => {
    const detail = await getIssue(stubClient({ projectMilestone: Promise.resolve({ id: "m1", name: "Launch", targetDate: new Date("2026-10-31") }) }), "ENG-123");
    expect(detail.milestone).toEqual({ id: "m1", name: "Launch", targetDate: "2026-10-31" });
    expect(renderIssueDetail(detail)).toContain("milestone: Launch (m1)   due: 2026-10-31");
    const undated = await getIssue(stubClient({ projectMilestone: Promise.resolve({ id: "m2", name: "Later" }) }), "ENG-124");
    expect(undated.milestone?.targetDate).toBeNull();
  });

  test("tolerates missing optional relations", async () => {
    const detail = await getIssue(
      stubClient({
        description: undefined,
        assignee: Promise.resolve(undefined),
        project: Promise.resolve(undefined),
        labels: () => Promise.resolve({ nodes: [] }),
      }),
      "CER-1406",
    );
    expect(detail.assignee).toBeNull();
    expect(detail.project).toBeNull();
    expect(detail.milestone).toBeNull();
    expect(detail.labels).toEqual([]);
    expect(detail.description).toBeNull();
  });
});

describe("renderIssueDetail", () => {
  const detail: IssueDetail = {
    id: "uuid-1",
    identifier: "CER-9",
    title: "T",
    url: "https://l/CER-9",
    state: "Todo",
    stateType: "unstarted",
    assignee: null,
    priority: "High",
    project: null,
    milestone: null,
    labels: ["bug"],
    parent: "CER-1",
    description: "body text",
    createdAt: "2026-06-20T10:00:00.000Z",
    updatedAt: "2026-07-01T09:00:00.000Z",
  };

  test("renders header, metadata lines, and the description body", () => {
    const out = renderIssueDetail(detail);
    expect(out).toContain("CER-9 [Todo]: T");
    expect(out).toContain("labels: bug");
    expect(out).toContain("parent: CER-1");
    expect(out).toContain("body text");
  });

  test("says so when there is no description", () => {
    const out = renderIssueDetail({ ...detail, description: null });
    expect(out).toContain("(no description)");
  });
});

describe("getIssue children", () => {
  function withChildren(pages: Array<Array<[string, string, string]>>): LinearClient {
    const base = stubClient() as any;
    base.client = {
      rawRequest: async (_q: string, vars: { after?: string }) => {
        const i = vars.after ? Number(vars.after) : 0;
        return { data: { issue: { children: {
          nodes: pages[i].map(([identifier, state, type]) => ({ identifier, title: `t-${identifier}`, state: { name: state, type } })),
          pageInfo: { hasNextPage: i + 1 < pages.length, endCursor: i + 1 < pages.length ? String(i + 1) : null },
        } } } };
      },
    };
    return base as LinearClient;
  }
  test("lists every page of children with a subtask summary", async () => {
    const detail = await getIssue(withChildren([
      [["CER-2", "Done", "completed"], ["CER-3", "Canceled", "canceled"]],
      [["CER-4", "Triage", "triage"], ["CER-5", "Duplicate", "duplicate"]],
    ]), "CER-1406");
    expect(detail.children?.map((c) => c.identifier)).toEqual(["CER-2", "CER-3", "CER-4", "CER-5"]);
    expect(detail.children?.[2]).toEqual({ identifier: "CER-4", title: "t-CER-4", state: "Triage", stateType: "triage" });
    expect(detail.subtaskSummary).toEqual({ total: 4, completed: 1, canceled: 1, duplicate: 1, open: 1, allCompleted: false });
  });
  test("no children: allCompleted is true (open === 0)", async () => {
    const detail = await getIssue(withChildren([[]]), "CER-1406");
    expect(detail.subtaskSummary).toEqual({ total: 0, completed: 0, canceled: 0, duplicate: 0, open: 0, allCompleted: true });
  });
});
