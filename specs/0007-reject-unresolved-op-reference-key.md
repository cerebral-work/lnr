---
status: complete
created: 2026-10-18
tags: [auth, cli, errors]
priority: medium
---

# 0007-reject-unresolved-op-reference-key

## Overview

`lnr` reads `LINEAR_API_KEY` from the environment only (AGENTS.md rule 7). A shell rc can export an unresolved 1Password secret reference (`op://vault/item/field`) into that variable. `lnr` then sends the reference as the key, and Linear rejects it. The user sees only "Linear authentication failed", and the real cause is not visible (CER-2926, parent CER-2900).

This spec makes `lnr` reject such a value before any network call, with a message that names the cause and the fix.

## Design

### Rule

A `LINEAR_API_KEY` whose value, after leading and trailing whitespace is removed, starts with `op://` is an unresolved 1Password reference.

On such a value, every path that reads the key fails before it makes a network call:

- exit code `3` (`auth`), with the standard error envelope;
- message: `LINEAR_API_KEY is an unresolved 1Password reference (op://…), not a Linear API key.`
- hint: ``Run lnr through `opr` (or `op run -- lnr …`) so the reference is resolved, or export the resolved key.``

The message and the hint never contain the value. Any other non-empty value passes through unchanged.

### Readers

| Implementation | Reader | Paths it guards |
|---|---|---|
| TypeScript | `apiKeyFromEnv()` in `src/client.ts` | `makeClient()` (every SDK command, `resolveAuth()`, the MCP server), `ratelimit`, and the `file --stdin --apply` quota probe |
| Rust | `LinearClient::from_env()` in `crates/lnr-cli/src/graphql.rs` | every command that builds a `LinearClient` |

The redaction reads of the key (`src/lib/errors.ts`, `crates/lnr-cli/src/cli.rs`) make no network call and do not change.

The OAuth path (`makeOAuthClient`, `resolveAuth(accessToken)`) does not read `LINEAR_API_KEY` and does not change.

## Plan

- [x] Author this spec and register it in `specs/README.md`.
- [x] Add `apiKeyFromEnv()` to `src/client.ts`. Use it in `makeClient()`, `src/commands/ratelimit.ts` and `src/commands/file.ts`.
- [x] Add the same check to `LinearClient::from_env()`.
- [x] Add red-first tests: `test/op-reference-key.test.ts` and `crates/lnr-cli/tests/agent_contract.rs`.

## Test

```bash
bun test test/op-reference-key.test.ts
cargo test -p lnr-cli --locked -j 2 --test agent_contract op_reference
make check JOBS=2
```

The tests prove three facts:

1. An `op://` key fails with exit code `3` and the message above, and the value does not appear in the output.
2. No network call occurs.
   - **TypeScript:** a `fetch` spy records zero calls when an `op://` key drives a real SDK request (`makeClient().viewer`) and `ratelimit`. As a control, the same SDK request with a normal key reaches the spy once.
   - **Rust:** `LINEAR_API_URL` points at a local listener that counts connections and drops them. A normal key makes one connection and fails in the transport; an `op://` key adds no connection and fails with `auth`.
3. A normal key passes through unchanged. The `fetch` spy receives it as the `Authorization` header.

## Notes

- `lnr` does not resolve the reference itself. Resolution needs the 1Password CLI and a credential read, which belong to the caller (`opr`, `op run`).
- The check matches only the `op://` prefix. Other malformed keys still fail at Linear with the existing `auth` error.
