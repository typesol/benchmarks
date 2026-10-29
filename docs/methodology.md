# Methodology

What a number in `results.json` means, and what it does not.

## What is measured

- **Compute units**: the mean over the scenario's calls of each instruction, each alone in its transaction, in LiteSVM
  (an in-process Solana runtime with the mainnet cost model). `run.ts` runs every scenario for `rounds` rounds.
- **Binary size**: the deployed `.so` in KB (1024 bytes), as built: TypeSOL with its compiler, the Rust programs with
  `cargo-build-sbf` (release profile of their workspace).

## What must hold before a number is reported

- **Same outcome.** After the scenario, the observable state (decoded account fields, lamports and token balances,
  which accounts exist) must be equal in all four implementations, field by field where layouts differ; otherwise the
  program is reported as failed, not measured.
- **Same refusals.** The hostile calls (a stranger signing, an overflow, a withdrawal below rent, a fake maker, an
  empty offer, …) run after the outcome is captured; how each implementation handled them is in `probes`, the error
  each refusal returned in `probeErrors` (`Custom(<code>)` for a program error), and differences are written in the
  program's `notes`.
- **Same addresses.** Every implementation runs at the same program address with the same deterministic wallets, so
  PDAs and bump searches cost the same.

## Fairness notes

- The `run.ts` programs were written for this comparison: the native and Pinocchio versions are hand-tuned (Pinocchio
  reads account data without borrow tracking), and all four make the same checks.
- The official native and Pinocchio programs are teaching code: many skip checks Anchor and TypeSOL make (account owner
  and type, PDA re-derivation, signer checks), take bumps from the client, or log addresses. Their numbers include
  that, and each program's `notes` says what was observed.
- Several TypeSOL ports of the official examples are PARTIAL (see the TypeSOL repository's `test/ports/README.md`);
  where that costs compute units it is said in `notes`.

## Programs the benchmarks call

The token ports call Metaplex Token Metadata. `scripts/setup.sh` dumps it from mainnet-beta, and `results.json` records
its sha256 (`toolchain.tokenMetadataSha256`): an upgrade of that program changes the compute units of every
implementation's instructions that call it (all four by the same amount), not the comparison.

## Reproducing a published result

Each released compiler's results are in `results/<version>.json`.

Check out this repository at the commit that wrote the result, keep `@typesol/cli` at the version its `toolchain`
names, install the same Agave / platform-tools, and run `scripts/setup.sh` and the suite. LiteSVM's compute-unit model
is deterministic: the same programs give the same numbers.

`toolchain.typesolBuild` records how the TypeSOL programs were compiled: the clang of the platform-tools, the SBPF
version, profiling off, and the sha256 of the runtime header (TypeSOL always compiles at -O2).

## Regressions

The `bench` workflow runs `run.ts` on every push and pull request (and the official examples on demand), then
`scripts/compare.ts` checks the fresh numbers against the committed `results.json`. Any difference in compute units,
binary size or a probe's outcome fails the run, with the differences listed in the job summary. A change that is meant
to move the numbers commits the new `results.json` with it.
