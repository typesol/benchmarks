# Changelog

Results change with the compiler and the toolchain; each run records both in `results.json` (`toolchain`). This file
lists changes to the benchmarks themselves: programs, scenarios, methodology and tooling.

## Unreleased

## 2026-10-28

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
