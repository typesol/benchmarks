# Changelog

Versions follow the organization's [versioning policy](https://github.com/typesol/.github/blob/main/VERSIONING.md).
Results change with the compiler and the toolchain; each run records both in `results.json` (`toolchain`). This file
lists changes to the benchmarks themselves: programs, scenarios, methodology and tooling.

## Unreleased

- `official.ts` records the error each refused hostile call returned (`probeErrors`): Anchor and TypeSOL as
  `Custom(<code>)`, native and Pinocchio as the runtime's error.
- `toolchain.typesolBuild`: the clang, SBPF version and runtime header hash the TypeSOL programs were built with.
- CI fails when a run's numbers differ from the committed `results.json` (`scripts/compare.ts`), with the
  differences in the job summary.

## 0.1.1 — 2026-10-28

- Measured with `@typesol/cli` 0.24.1 (smaller TypeSOL programs, the same results; the other implementations are
  unchanged).

## 0.1.0 — 2026-10-28

First public version.

- `run.ts`: counter, vault and escrow in TypeSOL, Anchor, native Rust and Pinocchio, with identical final state
  required before any number is reported.
- `official.ts`: the official solana-developers/program-examples (de09019) in Anchor, native and Pinocchio, unmodified,
  next to TypeSOL ports of the Anchor versions.
- The TypeSOL side is pinned: the compiler from npm (`@typesol/cli`, exact version in `package.json`) and its programs
  from the TypeSOL repository at that version's tag (`scripts/setup.sh`); `TYPESOL_REPO` measures a checkout instead.
- `results.json` records the toolchain (TypeSOL, Anchor, Pinocchio and solana-program versions, cargo-build-sbf and
  platform-tools, Node).
- `mainnet-escrow.ts`: the official escrow on mainnet-beta (RPC and keys from the environment).
