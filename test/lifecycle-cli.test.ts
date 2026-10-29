import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { close } from "../src/commands/update.js";
import { review } from "../src/commands/review.js";
import { cliError } from "../src/lib/errors.js";
import { family, stub } from "./lifecycle-stub.js";

// The injected stub must be the only client: with no key, any fall-through to makeClient() throws instead of reaching Linear.
const savedKey = process.env.LINEAR_API_KEY;
beforeEach(() => { delete process.env.LINEAR_API_KEY; });
afterEach(() => { process.exitCode = 0; if (savedKey !== undefined) process.env.LINEAR_API_KEY = savedKey; });

function capture() {
  const out: string[] = [];
  const w = spyOn(process.stdout, "write").mockImplementation(((t: string) => { out.push(String(t)); return true; }) as never);
  const e = spyOn(process.stderr, "write").mockImplementation((() => true) as never);
  return { out, restore: () => { w.mockRestore(); e.mockRestore(); } };
}

describe("close command wiring", () => {
  test("guard refusal rejects with the refused exit code (6) and writes nothing", async () => {
    const s = stub({ rows: family(["Triage"]) });
    const c = capture();
    try {
      await close("CER-1", { json: true }, s.client).then(() => { throw new Error("expected refusal"); }, (e) => { expect(cliError(e).code).toBe(6); });
    } finally { c.restore(); }
    expect(s.calls.some((x) => x.startsWith("update:"))).toBe(false);
  });
  test("a failed flip sets exitCode 1 and prints commentPosted/closed in JSON", async () => {
    const s = stub({ rows: [{ identifier: "CER-9", title: "t", state: "Todo" }], failUpdateFor: "CER-9" });
    const c = capture();
    try { await close("CER-9", { json: true, comment: "x" }, s.client); } finally { c.restore(); }
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(c.out.join(""))).toMatchObject({ commentPosted: true, closed: false });
  });
  test("rollupError sets exitCode 1 while the child close stands", async () => {
    const s = stub({ rows: family(["Todo"]), failUpdateFor: "CER-1" });
    const c = capture();
    try { await close("CER-2", { json: true, rollup: true }, s.client); } finally { c.restore(); }
    expect(process.exitCode).toBe(1);
    const j = JSON.parse(c.out.join(""));
    expect(j.closed).toBe(true);
    expect(j.rollupError).toBeTruthy();
  });
  test("success leaves exitCode untouched", async () => {
    const s = stub({ rows: [{ identifier: "CER-9", title: "t", state: "Todo" }] });
    const c = capture();
    try { await close("CER-9", { json: true }, s.client); } finally { c.restore(); }
    expect(process.exitCode ?? 0).toBe(0);
  });
  test("--duplicate-of with --commit/--pr/--rollup/--comment is a usage error before any API call", async () => {
    for (const extra of [{ commit: "a" }, { pr: "1" }, { rollup: true }, { comment: "x" }]) {
      const s = stub({ rows: family() });
      await close("CER-2", { duplicateOf: "CER-1", ...extra }, s.client).then(() => { throw new Error("expected usage error"); }, (e) => { expect(cliError(e).kind).toBe("usage"); });
      expect(s.calls).toEqual([]);
    }
  });
});

describe("review command wiring", () => {
  test("attach failure sets exitCode 1 and prints moved/attached in JSON", async () => {
    const s = stub({ rows: [{ identifier: "CER-9", title: "t", state: "Todo" }], failAttach: true });
    const c = capture();
    try { await review("CER-9", { json: true, pr: "5", repo: "o/r" }, s.client); } finally { c.restore(); }
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(c.out.join(""))).toMatchObject({ moved: true, attached: false });
  });
});
