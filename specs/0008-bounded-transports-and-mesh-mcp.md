---
status: complete
created: 2026-10-26
tags: [mcp, cortex, transport, interoperability]
priority: high
depends_on: [0002-lnr-rust-port]
---

# 0008-bounded-transports-and-mesh-mcp

## Overview

Apply recent Cortex/Scorcher framing and observation contracts to lnr's agent
interfaces. Preserve JSON-RPC stdio compatibility and existing CLI aliases while
bounding transport work and providing direct evidence readback.

## Design

- Native MCP negotiates the supported protocol versions used by the installed
  TypeScript SDK, rejects malformed JSON-RPC, and bounds each input line at 1 MiB.
  Notifications never invoke tools. Tool execution remains sequential.
- Both MCP servers support `mcp serve --read-only`. Mutation tools are omitted
  from discovery and refused at dispatch, independently of client annotations.
- Add read-only `issue_comments` and `cortex_repo_query` tools. Comments are
  issue-scoped, bounded, and include pagination evidence. Cortex observations
  delegate to the installed `cortex repo-query --json --max-patch-bytes 0`,
  use a deadline and 128 KiB ceiling, and retain `authority: observation_only`.
  No mesh credential is loaded, no shell is used, and no message is sent.
- Native milestone metadata discovery reads the API and exposes pageInfo/partial
  instead of returning the former hard-coded empty list.
- Native GraphQL requests have connect and total deadlines, ignore curl's user
  configuration, escape configuration strings, request compressed responses,
  and reject malformed/missing GraphQL data. Mutations are never auto-retried.
- Operator control sockets count UTF-8 bytes, enforce header/body limits and a
  total request deadline, reject invalid lengths, and execute one request per
  connection. Existing wire syntax and socket permissions remain unchanged.
- MCP discovery reports the running package version and read/write annotations.

## Plan

- [x] Implement bounded native MCP and read-only catalogs in both runtimes.
- [x] Add direct comment readback and Cortex observation integration.
- [x] Harden GraphQL and control-socket framing and deadlines.
- [x] Cover fragmented Unicode, malformed/oversized frames, denied mutations,
  protocol negotiation, and independent comment readback with offline tests.
- [x] Document evidence sources, limits, setup, and compatibility.

## Test

```sh
bun run typecheck
bun test
cargo test --workspace --locked -j 2
cargo clippy --workspace --all-targets --locked -j 2 -- -D warnings
cargo run --locked -j 2 -p xtask -- spec-check
```

## Notes

Sources: Cortex specs 0009 (inline/SHM transport) and 0036 (bounded repo-query);
AGY session a11bbefd's wire-protocol research and Scorcher PR #10; Claude Cortex
session 1f652360's comment readback workaround; this lane's OPS-1800 readback.
These motivate bounded application frames and evidence, not claims that lnr
implements QUIC, memfd, SCDS, or Scorcher's benchmark performance.
