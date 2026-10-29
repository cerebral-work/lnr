import { describe, expect, test } from "bun:test";
import { makeClient } from "../src/client.js";

describe("test suite never reaches live Linear", () => {
  test("auth env vars are unset in the test process", () => {
    for (const name of ["LINEAR_API_KEY", "LINEAR_OAUTH_CLIENT_ID", "LINEAR_OAUTH_CLIENT_SECRET", "LINEAR_OAUTH_REDIRECT_URI"]) {
      expect(process.env[name]).toBeUndefined();
    }
  });
  test("makeClient without a key throws instead of going anonymous", () => {
    expect(() => makeClient()).toThrow("LINEAR_API_KEY is not set");
  });
  test("fetch to linear.app is blocked (unless LNR_LIVE_CONTRACT_KEY opts in)", async () => {
    if (process.env.LNR_LIVE_CONTRACT_KEY) return;
    await expect(fetch("https://api.linear.app/graphql", { method: "POST" })).rejects.toThrow("blocked");
  });
});
