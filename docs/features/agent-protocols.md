# Agent protocols and evidence readback

Both `lnr` and `linearctl` expose these interfaces. Native Rust and Bun MCP
servers preserve newline-delimited JSON-RPC over stdio; stdout carries protocol
messages only. There is no new HTTP listener or mesh credential store.

## Read-only MCP for agent harnesses

Run `lnr mcp serve --read-only` when a lane delegates Linear writes elsewhere.
Both discovery and dispatch exclude mutations. Annotations describe tools;
`--read-only` enforces the restriction. Existing `mcp serve` callers retain the
write-capable catalog.

Use the same process arguments in Claude Code, AGY and other MCP clients:

```json
{
  "command": "lnr",
  "args": ["mcp", "serve", "--read-only"]
}
```

Provide `LINEAR_API_KEY` through the launch environment, never as an argument or
literal in a committed MCP configuration. The Bun server validates the key on
startup; native Rust validates it when a Linear tool executes. Native MCP
negotiates 2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05 or 2024-10-07, matching
the installed TypeScript SDK. An unsupported version returns the server's latest
supported version so the client can decide whether to continue.

The native server accepts frames up to 1 MiB, returns JSON-RPC parse/request
errors, and terminates an oversized input stream without interpreting its tail
as another request. Notifications do not execute tools. Tool calls execute
sequentially. This change does not add concurrent execution or cancellation.

## Direct comment readback

After a write returns a comment ID, read the issue's comments independently:

```sh
lnr comments --issue CER-123 --limit 50 --json
lnr comments --issue CER-123 --limit 50 --after '<endCursor>' --json
```

The response contains `issue`, `comments` (including `id`, `body`, `url` and
`createdAt`) and `pageInfo`. Check `hasNextPage` and continue with `endCursor`
when the receipt is not in the current page. An absent receipt on a partial page
is not evidence that the write failed. Limits must be integers from 1 to 100;
default 50. Existing `comments --author …` behavior is unchanged.

MCP clients call `issue_comments` with `{ "id": "CER-123", "limit": 50 }` and an
optional `after` cursor. No author-wide scan or extra Linear MCP connection is
required. Successful object results include `structuredContent`; text results
remain available for older clients. Native token-budgeted calls retain their
budgeted text without embedding an unabridged structured copy.

## Native milestone discovery

`lnr milestone list --project <UUID-or-name> --json` now reads the actual
milestone connection rather than returning a static empty list. It returns up to
100 metadata records with `pageInfo` and `partial`; pass `--after <endCursor>`
for continuation. Native MCP exposes the same read as `milestone_list`. This is
metadata discovery; use the Bun `milestone --project …` progress view when you
need issue completion counts. A partial page cannot prove an item is absent.

## Cortex repository context

The read-only MCP tool `cortex_repo_query` takes an optional `directory`. It
executes this fixed command in that checkout, without a shell:

```sh
cortex repo-query --json --max-patch-bytes 0
```

Cortex owns Git observation and checkout-identity checks. lnr enforces a five
second subprocess deadline and 128 KiB output ceiling, validates document type,
schema version 1 and `authority: observation_only`, and removes `LINEAR_API_KEY`
from the child environment. Failures produce tool errors, never empty success
or fabricated repository state. Cortex must be installed on `PATH`. The report
is an observation, not approval to write, merge or deploy. No mesh message is
sent or acknowledged by this tool.

## Network and operator IPC limits

Native GraphQL requests ignore user `.curlrc`, request supported compressed
responses, use five second connect and thirty second total deadlines, and apply
curl's 8 MiB response-size limit. URL, authorization and JSON configuration values
are escaped independently; keys and bodies travel over stdin. Transport failures
and malformed/missing GraphQL data fail explicitly. Mutations are not retried:
an uncertain write outcome requires independent readback before retrying.

The operator's existing Unix-socket protocol uses byte-counted `Content-Length`,
8 KiB headers and 1 MiB bodies. UTF-8 is decoded after the entire body arrives.
Buffers grow geometrically to avoid copying the complete accumulated payload on
every fragment. Invalid/duplicate lengths are rejected before dispatch; one
connection executes one request. A thirty second ingress deadline bounds partial
requests; the client timeout covers the entire exchange. Existing socket paths,
0700 parent directories and 0600 sockets are retained.

## Source decisions

- AGY session `a11bbefd-6ef1-47c2-97b7-3831549d5efc`, wire-protocol research and
  Scorcher PR #10: bounded application frames and avoiding repeated copies.
- Cortex specs 0009 and 0036: inline IPC boundaries and bounded `repo-query/v1`
  observations. lnr delegates to Cortex instead of duplicating its transport.
- Claude Cortex session `1f652360-5ca9-4fed-b784-b3638c6a9ce9`: `show` does not
  return comment receipts, forcing an additional MCP readback connection.
- Linear lane's OPS-1800 receipt: direct issue-scoped readback is needed after
  each serialized write.
- [MCP TypeScript SDK v1.29.0 server documentation](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.29.0/docs/server.md):
  standard stdio transport, tool annotations and structured results.

Scorcher's SCDS/SCDP, memfd and QUIC research remain separate protocols. This
change makes no zero-copy, binary-codec or benchmark-performance claim for lnr.
