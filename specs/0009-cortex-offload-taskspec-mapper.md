---
status: complete
created: 2026-11-25
tags: [rust, cortex, offload, escapement, operator]
priority: high
depends_on: [0006-intake-plan-submission-and-runbook, 0008-bounded-transports-and-mesh-mcp]
---

# 0009-cortex-offload-taskspec-mapper

## Overview

Implement `OPS-2251` Slice A in zero-I/O `crates/lnr-domain::offload`: map fail-closed opted-in Linear `IntakeCandidate` items and repository bindings into declarative `escapement.dispatch.v1.TaskSpec` proto3 JSON payloads and `Cortex Spec 0121` (`service-offload-intake`) mesh dispatch envelopes (`kind = "msg"`, subject `offload: <request_key>`).

## Design

### Why `PlanSubmission` (`0006`) Cannot Travel Over `Cortex Spec 0121`

- `Spec 0006` (`crates/lnr-domain::intake::PlanSubmission`) emits `escapement.plan-submission.v1` with free-text `title` and `goal`.
- `Vespertin Spec 0136` (`REQ-0136-03`, `REQ-0136-04`) and `escapement-proto::parse_task_spec_json` forbid free-text prompts and reject any JSON field outside `escapement.dispatch.v1.TaskSpec` (`repo`, `baseRef`, `baseSha`, `portCommit` | `change: { ticket, specPath }`, `allowedPaths`, `checkIds`, `deliverable`), bounded at `65_536` bytes (`MAX_DISPATCH_WIRE_BYTES`).
- `Cortex Spec 0121` (`REQ-0121-01`, `REQ-0121-02`) transports those exact `TaskSpec` JSON bytes as the body of one `kind = "msg"` mesh message to role `service-offload-intake` with subject `offload: <request_key>`, where `<request_key>` matches `[A-Za-z0-9_-]{1,64}`.

### Zero-I/O Domain Surface (`crates/lnr-domain::offload`)

- **Constants**:
  - `OFFLOAD_INTAKE_ROLE = "service-offload-intake"`
  - `OFFLOAD_SUBJECT_PREFIX = "offload: "`
  - `MAX_DISPATCH_WIRE_BYTES = 65_536`
  - `MAX_REQUEST_KEY_LEN = 64`
- **Fail-Closed Policy Guard**:
  - `map_candidate_to_offload(candidate, policy, binding)` requires `policy.required_labels` to be non-empty (at least one non-blank opt-in label) before running `evaluate_intake(candidate, policy)`, preventing accidental queue-wide dispatch when label configuration is omitted.
- **Declarative `OffloadTaskSpec` (`camelCase`, `deny_unknown_fields`)**:
  - `repo`: `<owner>/<name>` (`[A-Za-z0-9._-]+/[A-Za-z0-9._-]+`, rejecting `.` and `..`).
  - `baseRef`: non-empty Git ref name without leading `-`/`/`, `..`, `//`, control/non-ASCII bytes, whitespace, or Git ref- banning metacharacters (`~`, `^`, `:`, `?`, `*`, `[`, `\`).
  - `baseSha`: exact 40 lowercase ASCII hex characters.
  - `change`: `{ ticket, specPath }` with `ticket` matching canonical `<TEAM>-<NNN>` and `specPath` validated as a safe relative repository path.
  - `allowedPaths`: non-empty list of safe relative repository paths (`[A-Za-z0-9._/-]+`, no leading `/`, no empty, `.`, or `..` segments, rejecting whitespace, newlines, and zero-width characters).
  - `checkIds`: non-empty list of `<project>:<task>` identifiers (`[a-z0-9_-]+:[a-z0-9_-]+`).
  - `deliverable`: `OffloadDeliverable::DraftPr` (`"DELIVERABLE_DRAFT_PR"`).
- **Deterministic Idempotency Key & Mesh Envelope (`OffloadMeshEnvelope`)**:
  - `OffloadRequestKey`: validated against `[A-Za-z0-9_-]{1,64}`; default deterministic key `lnr-<TICKET>-<base_sha12>` preserves idempotent retries for `(issue, base_sha)` under `REQ-0121-11`.
  - `OffloadMeshEnvelope`: `{ target_role: "service-offload-intake", kind: "msg", request_key, subject: "offload: <key>", linear_issue_id, task_spec, body_json }` with `body_json.len() <= 65_536`.

## Plan

- [x] Author `specs/0009-cortex-offload-taskspec-mapper.md` and register in `specs/README.md`.
- [x] Implement zero-I/O `crates/lnr-domain/src/offload.rs` and export in `crates/lnr-domain/src/lib.rs`.
- [x] Add unit tests and negative-control break-checks covering fail-closed opt-in policy, `REQ-0136-03` field validation, prompt-injection rejection, wire-size cap, and `Spec 0121` subject/key grammar.

## Test

```bash
cargo run -q -p xtask --locked -j 2 -- spec-check
cargo test --workspace --locked -j 2
cargo test --doc --workspace --locked -j 2
cargo clippy --workspace --all-targets --locked -j 2 -- -D warnings
cargo fmt --all -- --check
```

## Notes

- Preserves Wave-0 zero-I/O purity in `crates/lnr-domain` and adds zero external dependencies (`Cargo.lock` unchanged).
- Live operator wiring (`--role queue-dispatch` and `LNR_OFFLOAD_MODE=live`) remains gated on `Cortex Spec 0121` P3 (`worker.offloadIntake.mode: live`), `Vespertin Spec 0136` P3, and `OPS-1876` (`OPS-2251` Slices B and C).
