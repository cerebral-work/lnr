import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { LinearClient } from "@linear/sdk";
import { ghSubprocessEnv, parseGhJson, xref } from "../src/core/xref.js";

function mockLinearClient(): LinearClient {
  return {
    client: {
      rawRequest: async () => ({
        data: { issue: { state: { name: "In Progress", type: "started" } } },
      }),
    },
  } as unknown as LinearClient;
}

function withFakeGh<T>(
  scriptBody: string,
  envOverrides: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "lnr-fake-gh-"));
  const ghPath = join(dir, "gh");
  writeFileSync(ghPath, `#!/usr/bin/env bash\nset -euo pipefail\n${scriptBody}\n`, "utf8");
  chmodSync(ghPath, 0o755);

  const savedEnv = new Map<string, string | undefined>();
  const nextPath = `${dir}:${process.env.PATH ?? ""}`;
  savedEnv.set("PATH", process.env.PATH);
  process.env.PATH = nextPath;
  for (const [k, v] of Object.entries(envOverrides)) {
    savedEnv.set(k, process.env[k]);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }

  return fn().finally(() => {
    for (const [k, v] of savedEnv.entries()) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  });
}

describe("ghSubprocessEnv & parseGhJson", () => {
  test("ghSubprocessEnv disables forced color, spinners, prompts, and pagers", () => {
    const env = ghSubprocessEnv({
      PATH: "/usr/bin",
      GH_TOKEN: "redacted",
      CLICOLOR_FORCE: "1",
      FORCE_COLOR: "3",
      GH_FORCE_TTY: "100%",
      GH_PAGER: "less",
    });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.GH_TOKEN).toBe("redacted");
    expect(env.GH_SPINNER_DISABLED).toBe("1");
    expect(env.GH_PROMPT_DISABLED).toBe("1");
    expect(env.GH_PAGER).toBe("cat");
    expect(env.NO_COLOR).toBe("1");
    expect(env.CLICOLOR).toBe("0");
    expect(env.CLICOLOR_FORCE).toBe("0");
    expect(env.FORCE_COLOR).toBe("0");
    expect(env.GH_FORCE_TTY).toBeUndefined();
  });

  test("parseGhJson strips spinner prefix and SGR color tokens while preserving JSON-escaped \\u001b", () => {
    const raw =
      '\r\x1b[?25l⣾\r⣽\r⣻\r\x1b[K\x1b[?25h\x1b[1;37m[\x1b[m\n  \x1b[1;37m{\x1b[m\n    \x1b[1;34m"number"\x1b[m\x1b[1;37m:\x1b[m \x1b[33m7\x1b[m,\n    \x1b[1;34m"body"\x1b[m\x1b[1;37m:\x1b[m \x1b[32m"sample \\u001b[31mred\\u001b[0m"\x1b[m\n  \x1b[1;37m}\x1b[m\n\x1b[1;37m]\x1b[m\n';
    const parsed = parseGhJson<Array<{ number: number; body: string }>>(raw);
    expect(parsed).toEqual([{ number: 7, body: "sample \x1b[31mred\x1b[0m" }]);
  });
});

describe("xref gh subprocess ANSI & spinner resilience", () => {
  test("passes sanitized env to child gh process even when parent has CLICOLOR_FORCE=1 and GH_FORCE_TTY", async () => {
    // Fail non-zero if ghPRList did not sanitize the child environment, proving env sanitization independently of parseGhJson.
    const fakeGh = `
if [ "\${CLICOLOR_FORCE:-}" != "0" ] || [ -n "\${GH_FORCE_TTY:-}" ] || [ "\${GH_SPINNER_DISABLED:-}" != "1" ] || [ "\${NO_COLOR:-}" != "1" ] || [ "\${GH_PAGER:-}" != "cat" ]; then
  echo "unsanitized gh env" >&2
  exit 1
fi
printf '[{"number":101,"title":"feat: test (CER-42)","body":"Closes CER-42","headRefName":"feat/cer-42","url":"https://github.com/org/repo/pull/101"}]\\n'
`;
    const res = await withFakeGh(
      fakeGh,
      {
        CLICOLOR_FORCE: "1",
        FORCE_COLOR: "3",
        GH_FORCE_TTY: "100%",
        GH_SPINNER_DISABLED: undefined,
        NO_COLOR: undefined,
        GH_PAGER: "less",
      },
      () => xref(mockLinearClient(), { repo: "cerebral-work/cortex", mergedLimit: 5 }),
    );
    expect(res.openPRs).toBe(1);
    expect(res.mergedPRs).toBe(1);
    expect(res.findings.some((f) => f.refs.includes("CER-42"))).toBe(true);
  });

  test("strips leading braille spinner bytes and inline ANSI escape sequences before JSON decode", async () => {
    const fakeGh = `
printf '\\r\\033[?25l⣾\\r⣽\\r⣻\\r\\033[K\\033[?25h\\033[1;37m[\\033[m\\n  \\033[1;37m{\\033[m\\n    \\033[1;34m"number"\\033[m\\033[1;37m:\\033[m \\033[33m202\\033[m,\\n    \\033[1;34m"title"\\033[m\\033[1;37m:\\033[m \\033[32m"fix: parser (CER-99)"\\033[m,\\n    \\033[1;34m"body"\\033[m\\033[1;37m:\\033[m \\033[32m"Closes CER-99\\\\nLog sample: \\\\u001b[31mred\\\\u001b[0m"\\033[m,\\n    \\033[1;34m"headRefName"\\033[m\\033[1;37m:\\033[m \\033[32m"fix/cer-99"\\033[m,\\n    \\033[1;34m"url"\\033[m\\033[1;37m:\\033[m \\033[32m"https://github.com/org/repo/pull/202"\\033[m\\n  \\033[1;37m}\\033[m\\n\\033[1;37m]\\033[m\\n'
`;
    const res = await withFakeGh(fakeGh, {}, () =>
      xref(mockLinearClient(), { repo: "cerebral-work/cortex", mergedLimit: 5 }),
    );
    expect(res.openPRs).toBe(1);
    expect(res.mergedPRs).toBe(1);
    expect(res.findings[0]?.refs).toEqual(["CER-99"]);
  });

  test("rejects genuinely non-JSON stdout instead of silently fabricating empty PR lists", async () => {
    const fakeGh = `printf 'HTTP 502 Bad Gateway from proxy\\n'`;
    await expect(
      withFakeGh(fakeGh, {}, () =>
        xref(mockLinearClient(), { repo: "cerebral-work/cortex", mergedLimit: 5 }),
      ),
    ).rejects.toThrow(/JSON|Unexpected|Unrecognized/i);
  });
});
