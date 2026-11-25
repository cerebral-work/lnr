import { describe, expect, test } from "bun:test";
import { makeTokenCache, type TokenMinter } from "../src/core/operator.js";
import { isAuthError } from "../src/lib/errors.js";

/**
 * Rules of the operator's token cache (CER-3309), on a stub minter. The
 * daemon-level behaviour is in operator-token-remint.test.ts.
 */

/** A minter whose mints resolve only when the test releases them. */
function gatedMinter(tokens: string[]) {
  let n = 0;
  const releases: Array<() => void> = [];
  const minter: TokenMinter = () =>
    new Promise<string>((resolve) => {
      const token = tokens[Math.min(n++, tokens.length - 1)]!;
      releases.push(() => resolve(token));
    });
  return { minter, mints: () => n, release: () => releases.shift()?.() };
}

describe("operator token cache (CER-3309)", () => {
  test("two runs rejected by the same expiry share one mint and leave auth ok", async () => {
    const m = gatedMinter(["tok-a", "tok-b"]);
    const cache = makeTokenCache(m.minter);
    const startup = cache.refreshToken();
    m.release();
    await startup;

    const first = cache.rejected("tok-a");
    const second = cache.rejected("tok-a");
    m.release();
    await Promise.all([first, second]);

    expect(m.mints()).toBe(2);
    expect(cache.getToken()).toBe("tok-b");
    expect(cache.status().auth).toBe("ok");
  });

  test("a rejection of a token that was already replaced is ignored", async () => {
    const m = gatedMinter(["tok-a", "tok-b"]);
    const cache = makeTokenCache(m.minter);
    const startup = cache.refreshToken();
    m.release();
    await startup;
    const renew = cache.rejected("tok-a");
    m.release();
    await renew;

    await cache.rejected("tok-a");
    expect(m.mints()).toBe(2);
    expect(cache.status().auth).toBe("ok");
  });

  test("a fresh token rejected again is failing, re-mints no sooner than the floor, and a success clears it", async () => {
    const m = gatedMinter(["tok-a", "tok-b"]);
    const cache = makeTokenCache(m.minter);
    const startup = cache.refreshToken();
    m.release();
    await startup;
    const renew = cache.rejected("tok-a");
    m.release();
    await renew;

    await cache.rejected("tok-b");
    expect(m.mints()).toBe(2);
    expect(cache.status().auth).toBe("failing");

    cache.succeeded();
    expect(cache.status().auth).toBe("ok");
  });

  test("a failed mint is failing until a run succeeds with the token it still holds", async () => {
    let calls = 0;
    const cache = makeTokenCache(async () => {
      calls += 1;
      if (calls === 2) throw new Error("token endpoint unavailable");
      return "tok-a";
    });
    await cache.refreshToken();
    await expect(cache.rejected("tok-a")).rejects.toThrow("token endpoint unavailable");
    expect(cache.status().auth).toBe("failing");

    cache.succeeded();
    expect(cache.status().auth).toBe("ok");
    expect(cache.status().tokenMints).toBe(1);
  });

  test("an issue id that contains 401 is not an auth failure", () => {
    expect(isAuthError(new Error("comment on CER-401 failed: Entity not found"))).toBe(false);
    expect(isAuthError({ status: 401, message: "Unauthorized" })).toBe(true);
  });
});
