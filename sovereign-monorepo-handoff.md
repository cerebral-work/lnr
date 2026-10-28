# Sovereign Monorepo Consolidation Handoff Notice

> [!IMPORTANT]
> **Notice of Repository Absorption into `cerebral-work/vespertin`**
> Under **LeanSpec 0017** (`specs/0017-estate-deconvolution-and-vespertin-consolidation.md`) and operator ruling (2026-10-27 & 2026-10-28), this repository is scheduled for consolidation into the unified sovereign monorepo:
> **[`cerebral-work/vespertin`](https://github.com/cerebral-work/vespertin)**

## 1. Subsystem Destination

| Source Surface | Target Subsystem in `vespertin` | Subsystem Purpose |
|---|---|---|
| `cerebral-work/lnr` | `vespertin/domain/linear/ & vespertin/revenant/lnr/` | Zero-I/O Linear domain model (`lnr-domain`, 33 modules) and `linearctl` / `lnr-cli` engine linked in-process into `godseat`. |

## 2. Consolidation Rules & Guidelines

1. **Zero Code Loss**: All active features, domain contracts, tests, and historical git lineage are preserved during migration.
2. **Clean Vendoring Rules**: Upstream vendor dependencies (`waymaker-core`, `autumn-harvest`, `autumn-schema-core`, `esper-core`, `esper-protocol`) retain original crate names, git provenance, authorship, and root license files under `vespertin/vendor/`.
3. **Orchestration Standard**: Build, test, and release orchestration standardizes on `tracel-xtask` (`cargo xtask` with mandatory `-j 2` host throttling), retiring `.moon/` and `Justfile`.
4. **Slack Transport Unification**: Slack integrations unify onto Slack App `revenant` (`A0C6JAFBQHY`) with the Oni Mask avatar (`:japanese_ogre:`).
5. **Post-Migration Archive**: Upon verification of `vespertin` CI and deployment checks, this repository will be transitioned to read-only archived state on GitHub (`gh repo archive`) under explicit operator gate `G-4`.

## 3. Governance and Inquiries

- **Lead Coordinator Lane**: `revenant` (`cerebral-work/revenant`, `estate/w53:pE`).
- **Partner Lane**: `vilicus` (`cerebral-work/vilicus`).
- **Specification Reference**: [LeanSpec 0017](https://github.com/cerebral-work/revenant/blob/main/specs/0017-estate-deconvolution-and-vespertin-consolidation.md).
