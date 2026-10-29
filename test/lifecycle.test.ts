import { describe, expect, test } from "bun:test";
import {
  closeWithEvidence,
  listChildren,
  resolvePrRef,
  reviewIssue,
  validateCloseOptions,
} from "../src/core/lifecycle.js";
import { cliError } from "../src/lib/errors.js";
import { family, noRemote, stub, writes } from "./lifecycle-stub.js";

describe("close parent guard", () => {
  test("refuses a parent with Triage/Backlog children and lists them; writes nothing", async () => {
    const s = stub({ rows: family(["Triage", "Backlog", "Done", "Canceled"]) });
    try { await closeWithEvidence(s.client, "CER-1", { comment: "x" }, noRemote); throw new Error("expected refusal"); }
    catch (e) {
      const err = cliError(e);
      expect(err.kind).toBe("refused");
      expect(err.message).toContain("CER-2");
      expect(err.message).toContain("CER-3");
      expect(err.message).not.toContain("CER-4");
    }
    expect(writes(s.calls)).toEqual([]);
  });
  test("--force overrides the guard", async () => {
    const s = stub({ rows: family(["Triage"]) });
    const r = await closeWithEvidence(s.client, "CER-1", { force: true }, noRemote);
    expect(r.closed).toBe(true);
    expect(writes(s.calls)).toEqual(["update:CER-1:Done"]);
  });
  test("completed/canceled children pass", async () => {
    const s = stub({ rows: family(["Done", "Canceled"]) });
    expect((await closeWithEvidence(s.client, "CER-1", {}, noRemote)).stateType).toBe("completed");
  });
});

describe("close write order", () => {
  test("receipt comment lands before the state flip and carries commit link + PR + text", async () => {
    const s = stub({ rows: [{ identifier: "CER-9", title: "t", state: "In Progress" }] });
    const r = await closeWithEvidence(s.client, "CER-9", { commit: "abc1234", pr: "7", repo: "o/r", comment: "verified live" }, noRemote);
    expect(writes(s.calls)).toEqual(["comment:CER-9", "update:CER-9:Done"]);
    const body = s.raw.bodies[0].body;
    expect(body).toContain("abc1234");
    expect(body).toContain("https://github.com/o/r/commit/abc1234");
    expect(body).toContain("https://github.com/o/r/pull/7");
    expect(body).toContain("verified live");
    expect(r).toMatchObject({ identifier: "CER-9", closed: true, commentPosted: true, prUrl: "https://github.com/o/r/pull/7" });
  });
  test("no evidence flags means no comment", async () => {
    const s = stub({ rows: [{ identifier: "CER-9", title: "t", state: "Todo" }] });
    const r = await closeWithEvidence(s.client, "CER-9", {}, noRemote);
    expect(writes(s.calls)).toEqual(["update:CER-9:Done"]);
    expect(r.commentPosted).toBe(false);
  });
  test("a failed comment never flips the state", async () => {
    const s = stub({ rows: [{ identifier: "CER-9", title: "t", state: "Todo" }], commentFails: true });
    await expect(closeWithEvidence(s.client, "CER-9", { comment: "x" }, noRemote)).rejects.toThrow("comment boom");
    expect(writes(s.calls)).toEqual(["comment:CER-9"]);
    expect(s.store.get("CER-9")!.state).toBe("Todo");
  });
  test("a failed flip after the comment reports commentPosted:true closed:false", async () => {
    const s = stub({ rows: [{ identifier: "CER-9", title: "t", state: "Todo" }], failUpdateFor: "CER-9" });
    const r = await closeWithEvidence(s.client, "CER-9", { comment: "x" }, noRemote);
    expect(r).toMatchObject({ commentPosted: true, closed: false });
    expect(r.error).toBeTruthy();
  });
});

describe("close --rollup", () => {
  test("fires on the last child only, with a receipt comment on the parent before its close", async () => {
    const s = stub({ rows: family(["In Progress", "In Progress"]) });
    const first = await closeWithEvidence(s.client, "CER-2", { rollup: true }, noRemote);
    expect(first.rolledUpParent ?? null).toBeNull();
    expect(writes(s.calls).filter((c) => c.includes("CER-1"))).toEqual([]);
    const last = await closeWithEvidence(s.client, "CER-3", { rollup: true }, noRemote);
    expect(last.rolledUpParent).toEqual({ identifier: "CER-1", state: "Done" });
    expect(writes(s.calls).slice(-3)).toEqual(["update:CER-3:Done", "comment:CER-1", "update:CER-1:Done"]);
  });
  test("sibling read is live: after closing child A the rollup read sees A completed", async () => {
    const s = stub({ rows: family(["Todo", "Done"]) });
    s.calls.length = 0;
    const r = await closeWithEvidence(s.client, "CER-2", { rollup: true }, noRemote);
    const flip = s.calls.indexOf("update:CER-2:Done");
    const sibling = s.calls.indexOf("children:CER-1", flip);
    expect(flip).toBeGreaterThan(-1);
    expect(sibling).toBeGreaterThan(flip);
    expect(r.rolledUpParent).toEqual({ identifier: "CER-1", state: "Done" });
  });
  test("rollup failure keeps the child closed and surfaces rollupError", async () => {
    const s = stub({ rows: family(["Todo"]), failUpdateFor: "CER-1" });
    const r = await closeWithEvidence(s.client, "CER-2", { rollup: true }, noRemote);
    expect(r.closed).toBe(true);
    expect(r.rollupError).toBeTruthy();
    expect(s.store.get("CER-2")!.state).toBe("Done");
  });
});

describe("close flag validation", () => {
  test("--duplicate-of cannot combine with --commit/--pr/--rollup/--comment", () => {
    for (const extra of [{ commit: "a" }, { pr: "1" }, { rollup: true }, { comment: "x" }]) {
      try { validateCloseOptions({ duplicateOf: "CER-1", ...extra }); throw new Error("expected usage error"); }
      catch (e) { expect(cliError(e).kind).toBe("usage"); }
    }
    expect(() => validateCloseOptions({ duplicateOf: "CER-1", force: true })).not.toThrow();
  });
});

describe("--pr resolution", () => {
  const url = "https://github.com/o/r/pull/12";
  test("number + --repo", () => expect(resolvePrRef("12", "o/r", () => undefined)).toEqual({ url, repo: "o/r", number: 12 }));
  test("number + ssh and https origin remotes", () => {
    expect(resolvePrRef("12", undefined, () => "git@github.com:o/r.git").url).toBe(url);
    expect(resolvePrRef("#12", undefined, () => "https://github.com/o/r.git").url).toBe(url);
    expect(resolvePrRef("12", undefined, () => "https://github.com/o/r").url).toBe(url);
  });
  test("full URL needs no remote", () => expect(resolvePrRef(url, undefined, () => undefined).repo).toBe("o/r"));
  test("unresolvable remote is a usage error, never a guess", () => {
    for (const remote of [undefined, "git@gitlab.com:o/r.git", "garbage"]) {
      try { resolvePrRef("12", undefined, () => remote); throw new Error("expected usage error"); }
      catch (e) { expect(cliError(e).kind).toBe("usage"); }
    }
    try { resolvePrRef("not-a-pr", "o/r", () => undefined); throw new Error("x"); } catch (e) { expect(cliError(e).kind).toBe("usage"); }
  });
});

describe("review", () => {
  test("moves to In Review and attaches the PR", async () => {
    const s = stub({ rows: [{ identifier: "CER-9", title: "t", state: "In Progress" }] });
    const r = await reviewIssue(s.client, "CER-9", { pr: "5", repo: "o/r" }, noRemote);
    expect(writes(s.calls)).toEqual(["update:CER-9:In Review", "attach:CER-9:https://github.com/o/r/pull/5"]);
    expect(r).toMatchObject({ identifier: "CER-9", state: "In Review", prUrl: "https://github.com/o/r/pull/5" });
  });
  test("falls back to the started In Progress state when the team has no In Review", async () => {
    const s = stub({ rows: [{ identifier: "CER-9", title: "t", state: "Todo" }], noReview: true });
    const r = await reviewIssue(s.client, "CER-9", {}, noRemote);
    expect(r.state).toBe("In Progress");
  });
  test("--rollup moves the parent only when every sibling is In Review or closed", async () => {
    const s = stub({ rows: family(["In Progress", "Done"]) });
    // CER-2 -> In Review, CER-3 already Done: parent rolls up.
    const r = await reviewIssue(s.client, "CER-2", { rollup: true }, noRemote);
    expect(r.rolledUpParent).toEqual({ identifier: "CER-1", state: "In Review" });
    const t = stub({ rows: family(["In Progress", "Todo"]) });
    const r2 = await reviewIssue(t.client, "CER-2", { rollup: true }, noRemote);
    expect(r2.rolledUpParent ?? null).toBeNull();
    expect(writes(t.calls).some((c) => c.includes("CER-1"))).toBe(false);
  });
});

describe("children listing", () => {
  test("paginates past the first page", async () => {
    const rows = [{ identifier: "CER-1", title: "p", state: "Todo" }, ...Array.from({ length: 5 }, (_, i) => ({ identifier: `CER-${i + 2}`, title: `c${i}`, state: i < 2 ? "Done" : i === 2 ? "Canceled" : "Todo", parent: "CER-1" }))];
    const s = stub({ rows, pageSize: 2 });
    const kids = await listChildren(s.client, "CER-1");
    expect(kids.map((k) => k.identifier)).toEqual(["CER-2", "CER-3", "CER-4", "CER-5", "CER-6"]);
    expect(s.calls.filter((c) => c === "children:CER-1")).toHaveLength(3);
    expect(kids[0]).toEqual({ identifier: "CER-2", title: "c0", state: "Done", stateType: "completed" });
  });
});

describe("duplicate-type children count as closed", () => {
  test("guard passes when the other child is Duplicate", async () => {
    const s = stub({ rows: family(["Done", "Duplicate"]) });
    expect((await closeWithEvidence(s.client, "CER-1", {}, noRemote)).closed).toBe(true);
  });
  test("rollup fires when the remaining sibling is Duplicate", async () => {
    const s = stub({ rows: family(["Todo", "Duplicate"]) });
    const r = await closeWithEvidence(s.client, "CER-2", { rollup: true }, noRemote);
    expect(r.rolledUpParent).toEqual({ identifier: "CER-1", state: "Done" });
  });
});

describe("partial failures are reported", () => {
  test("close: a throwing post-flip re-read reports flipped:true with the error", async () => {
    const s = stub({ rows: [{ identifier: "CER-9", title: "t", state: "Todo" }], failReadAfterUpdate: true });
    const r = await closeWithEvidence(s.client, "CER-9", { comment: "x" }, noRemote);
    expect(r).toMatchObject({ commentPosted: true, flipped: true, closed: false });
    expect(r.error).toContain("read boom");
  });
  test("review: attach failure after the move reports moved:true attached:false", async () => {
    const s = stub({ rows: [{ identifier: "CER-9", title: "t", state: "Todo" }], failAttach: true });
    const r = await reviewIssue(s.client, "CER-9", { pr: "5", repo: "o/r" }, noRemote);
    expect(r).toMatchObject({ moved: true, attached: false, state: "In Review" });
    expect(r.error).toContain("attach boom");
  });
  test("review: parent move failure keeps the child move and reports rollupError", async () => {
    const s = stub({ rows: family(["In Progress"]), failUpdateFor: "CER-1" });
    const r = await reviewIssue(s.client, "CER-2", { rollup: true }, noRemote);
    expect(r).toMatchObject({ moved: true, state: "In Review" });
    expect(r.rollupError).toBeTruthy();
  });
});

describe("--pr URL vs --repo", () => {
  test("a different --repo is a usage error; the same repo is fine", () => {
    const url = "https://github.com/o/r/pull/12";
    try { resolvePrRef(url, "x/y", () => undefined); throw new Error("expected usage error"); }
    catch (e) { expect(cliError(e).kind).toBe("usage"); }
    expect(resolvePrRef(url, "O/R", () => undefined).repo).toBe("o/r");
  });
});

describe("pagination guard", () => {
  test("a repeating endCursor fails instead of looping", async () => {
    const client = { client: { rawRequest: async () => ({ data: { issue: { children: { nodes: [], pageInfo: { hasNextPage: true, endCursor: "same" } } } } }) } };
    await expect(listChildren(client as never, "CER-1")).rejects.toThrow("did not advance");
  });
});
