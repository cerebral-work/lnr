import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { makeClient } from "../src/client.js";
import { ratelimit } from "../src/commands/ratelimit.js";
import { CliError, errorEnvelope, printCliError } from "../src/lib/errors.js";

// specs/0007: an unresolved 1Password reference in LINEAR_API_KEY fails before any network call.
const SENTINEL = "SentinelVault/lnr-item/credential";
const OP_REFERENCE = `op://${SENTINEL}`;
const NORMAL_KEY = "lin_api_test_only_normal_key";

let prior: string | undefined;
beforeEach(() => { prior = process.env.LINEAR_API_KEY; });
afterEach(() => {
  if (prior === undefined) delete process.env.LINEAR_API_KEY;
  else process.env.LINEAR_API_KEY = prior;
});

function quotaResponse(): Response {
  return new Response(JSON.stringify({ data: { viewer: { id: "viewer" } } }), {
    status: 200,
    headers: { "Content-Type": "application/json", "X-RateLimit-Requests-Remaining": "100", "X-RateLimit-Requests-Limit": "1500" },
  });
}

function expectOpReferenceError(err: unknown): void {
  expect(err).toBeInstanceOf(CliError);
  const e = err as CliError;
  expect(e.kind).toBe("auth");
  expect(e.code).toBe(3);
  expect(e.message).toContain("unresolved 1Password reference");
  expect(e.hint).toContain("opr");
  expect(e.hint).toContain("op run");
  expect(JSON.stringify(errorEnvelope(e))).not.toContain(SENTINEL);
}

describe("LINEAR_API_KEY holding an op:// reference (CER-2926)", () => {
  test("makeClient fails fast with the auth error and no network call", () => {
    process.env.LINEAR_API_KEY = OP_REFERENCE;
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((() => { throw new Error("network call attempted"); }) as never);
    try {
      let thrown: unknown;
      try { makeClient(); } catch (err) { thrown = err; }
      expectOpReferenceError(thrown);
      expect(fetchSpy).toHaveBeenCalledTimes(0);
    } finally { fetchSpy.mockRestore(); }
  });

  test("leading whitespace does not hide the reference", () => {
    process.env.LINEAR_API_KEY = `  ${OP_REFERENCE}\n`;
    let thrown: unknown;
    try { makeClient(); } catch (err) { thrown = err; }
    expectOpReferenceError(thrown);
  });

  test("ratelimit fails fast with the auth error and no network call", async () => {
    process.env.LINEAR_API_KEY = OP_REFERENCE;
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((() => { throw new Error("network call attempted"); }) as never);
    try {
      let thrown: unknown;
      try { await ratelimit({ json: true }); } catch (err) { thrown = err; }
      expectOpReferenceError(thrown);
      expect(fetchSpy).toHaveBeenCalledTimes(0);
    } finally { fetchSpy.mockRestore(); }
  });

  test("the printed error, text and JSON, never contains the value", () => {
    process.env.LINEAR_API_KEY = OP_REFERENCE;
    let thrown: unknown;
    try { makeClient(); } catch (err) { thrown = err; }
    const chunks: string[] = [];
    const writer = spyOn(process.stderr, "write").mockImplementation(((text: string) => { chunks.push(String(text)); return true; }) as never);
    try {
      expect(printCliError(thrown, false)).toBe(3);
      expect(printCliError(thrown, true)).toBe(3);
    } finally { writer.mockRestore(); }
    expect(chunks.join("")).toContain("unresolved 1Password reference");
    expect(chunks.join("")).not.toContain(SENTINEL);
  });

  test("a normal key passes through unchanged", async () => {
    process.env.LINEAR_API_KEY = NORMAL_KEY;
    expect(() => makeClient()).not.toThrow();
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => quotaResponse()) as never);
    const out = spyOn(process.stdout, "write").mockImplementation((() => true) as never);
    try {
      await ratelimit({ json: true });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const init = fetchSpy.mock.calls[0][1] as RequestInit;
      expect((init.headers as Record<string, string>).Authorization).toBe(NORMAL_KEY);
    } finally { out.mockRestore(); fetchSpy.mockRestore(); }
  });
});
