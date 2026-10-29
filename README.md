# TypeSOL benchmarks

The same Solana programs written with [TypeSOL](https://github.com/typesol/typesol), Anchor, native Rust
(`solana-program`) and Pinocchio, compared on compute units and binary size. Every number here is reproducible: the
TypeSOL compiler comes from npm at the version in `package.json`, its programs from the TypeSOL repository at that
version's tag, and each result records the toolchain it was measured with (`results.json`, `toolchain`).

Two suites:

- **`run.ts`**: counter, vault and escrow, written four ways to the same encoding (Anchor discriminators), account
  layout and checks, so one client drives them all.
- **`official.ts`**: the Anchor, native and Pinocchio versions of
  [solana-developers/program-examples](https://github.com/solana-developers/program-examples), unmodified, next to
  TypeSOL ports of the Anchor versions.

## Running

Requirements: Node 22.12+, git, Rust and Agave 3.1.10 (`cargo-build-sbf`, platform-tools v1.52).

```sh
npm ci
bash scripts/setup.sh        # TypeSOL sources at the tag of the pinned @typesol/cli (vendor/typesol), the Anchor twins,
                             # this repository's native and Pinocchio programs
node run.ts                  # counter, vault, escrow → results.json
bash official/build.sh       # clones program-examples@de09019 and builds every variant unmodified (slow)
node official.ts             # the official examples → results.json (`official`)
```

To measure unreleased TypeSOL work, point both scripts at a checkout whose `dist/` is built (its examples, ports and
Anchor twins are used too): `TYPESOL_REPO=../typesol node run.ts`. `results.json` then names that checkout instead of
an npm version. Measure a pull request both ways (before and after) with the same toolchain. What the numbers mean
and what must hold before one is reported: [docs/methodology.md](docs/methodology.md).

`run.ts` sends identical transactions to each one in LiteSVM. All four implementations run at the same program
address, so PDAs and bump searches are identical. The script requires identical final account state, and requires
that the hostile calls (a stranger, an overflow, a withdrawal below rent, a fake maker, an empty offer) are refused. Only then does it report mean
compute units and binary sizes.


Paths in the TypeSOL and Anchor columns are in the TypeSOL repository (`vendor/typesol`).

| Program | TypeSOL | Anchor | Native / Pinocchio |
| --- | --- | --- | --- |
| counter | `examples/counter.ts` | `bench/anchor/programs/counter` | `programs/{native,pinocchio}-counter` |
| vault | `examples/vault.ts` | `bench/anchor/programs/vault` | `programs/{native,pinocchio}-vault` |
| escrow (SPL Token CPIs) | `examples/escrow.ts` | `bench/anchor/programs/escrow` | `programs/{native,pinocchio}-escrow` |

The escrow round trip: `make` creates the offer PDA and moves mint A into a vault the offer owns; `take` pays the maker
in mint B, releases the vault to the taker and closes the vault and the offer; `refund` returns the vault to the maker.
The native and Pinocchio versions build the SPL Token instructions by hand, and the Pinocchio one reads account data
without borrow tracking (`borrow_unchecked`), as hand-tuned Pinocchio programs do. TypeSOL and Anchor also refuse the
same account in two writable slots (Anchor error 2040); the native and Pinocchio versions leave that to the token
program.


## The official examples

`official.ts` compares TypeSOL with programs it did not write: the Anchor, native and Pinocchio versions of
[solana-developers/program-examples](https://github.com/solana-developers/program-examples) at commit `de09019` (MIT,
Solana Foundation), next to the TypeSOL ports of the Anchor versions (`test/ports/` of the TypeSOL repository).

```sh
official/build.sh                     # clones program-examples@de09019 into official/, builds every variant unmodified
node official.ts                                   # all programs; merges `official` into results.json
OFFICIAL_DRY_RUN=1 node official.ts escrow counter # some programs, results.json untouched
```

The ports' sources come from the TypeSOL sources' `test/ports` (or `TYPESOL_PORTS`). Metaplex Token Metadata is loaded
from the ports' `test/programs/mpl_token_metadata.so`.

How the official variants are built (`official/build.sh`): each the way the example's CI builds it, with
`cargo-build-sbf` (Agave platform-tools v1.52). Native and Pinocchio programs build in the repository's root workspace
with its `Cargo.lock` (its release profile has no LTO, so these binaries are larger than the hand-tuned ones in
`programs/`); the native cross-program-invocation programs have their own workspace. The Anchor programs build in their
`anchor/` workspaces, which ship no `Cargo.lock`: `anchor-lang = "1.0.2"` resolves to 1.2.1, as it does in the
repository's CI. Nothing in the programs is changed; the build only adds those lock files.

How they are compared: each implementation runs at the Anchor program's declared address in its own LiteSVM, with the
same deterministic wallets, and gets the instructions in its own encoding (the native and Pinocchio versions have their
own instruction layouts and account orders, taken from each example's TypeScript tests). Every program has a scenario in
`official/examples/<name>.ts`: the flows the example's tests exercise, mostly 20 rounds. The observable outcome (decoded
account fields, lamports and token balances, which accounts exist) is normalized and must be the same in all four
implementations, compared field by field where layouts differ; otherwise the program is not reported. A measured
instruction is alone in its transaction. Where the variants split one job differently between client and program (a
TypeSOL `Zeroed` account the client allocates, against Anchor's `init` of a keypair account), the label ends in `(tx)`
and covers the whole transaction for all four. Hostile calls run after the outcome is captured; where implementations
handle them differently it is written in the program's `notes` in results.json.

Caveats:

- The official native and Pinocchio programs are teaching code. Many skip checks that Anchor and TypeSOL make (account
  owner and type, PDA re-derivation, signer checks), take bumps from the client instead of searching them, or log account
  addresses; their numbers include that. Each program's `notes` lists what was observed.
- Several TypeSOL ports are PARTIAL (see each port's header): keypair `init` becomes a client-allocated `Zeroed` account,
  account strings are `FixedString<N>` instead of Borsh strings, bumps passed as arguments, and token or Token-2022
  extension CPIs into accounts created in the same instruction are hand-encoded. Some of these cost compute units: the
  transfer-tokens and escrow ports always call the associated token account program's CreateIdempotent where native
  skips it for an existing account.
- Only instructions all four implement with the same meaning are reported. Not compared: `basics/realloc` (the native
  and Pinocchio versions grow an address record into other record types, not Anchor's message account) and
  `tokens/pda-mint-authority` (native and Pinocchio are a one-shot NFT minter with a separate mint authority PDA, not
  Anchor's PDA mint with repeated mints). `tokens/token-2022/transfer-fee` has no TypeSOL port; the other Token-2022 and
  token examples lack a native or Pinocchio version.
- Binary sizes of cross-program-invocation are the sum of the hand and lever programs.

| Program | Compared | Notes |
| --- | --- | --- |
| account-data | create_address_info (tx) | Pinocchio stores 16-byte fields |
| checking-accounts | check_accounts | native/Pinocchio log account addresses |
| close-account | create_user, close_user | native/Pinocchio keep an empty System account after close |
| counter | increment | native/Pinocchio have no initialize |
| create-account | create_system_account | |
| cross-program-invocation | initialize (tx), pull_lever | |
| favorites | set_favorites (create) | native/Pinocchio cannot update |
| pda-rent-payer | init_rent_vault, create_new_account | native/Pinocchio vault is program-owned |
| processing-instructions | go_to_park | |
| program-derived-addresses | create_page_visits, increment_page_visits | native/Pinocchio take the bump from the client |
| transfer-sol | transfer_sol_with_cpi, transfer_sol_with_program | |
| create-token | create_token_mint | Metaplex metadata CPI |
| escrow | make_offer, take_offer, refund_offer | |
| transfer-tokens | mint_token, transfer_tokens, transfer_tokens (new account) | create_token not compared (Pinocchio creates no metadata) |
| default-account-state | initialize + update_default_state (tx) | native/Pinocchio do both in one instruction |
| mint-close-authority | initialize | close not compared (native/Pinocchio have none) |
| non-transferable | initialize | |

`run.ts` keeps the `official` key when it rewrites results.json.

## On mainnet

`mainnet-escrow.ts` runs the official escrow against all four implementations deployed on mainnet-beta: the same
`make_offer` / `take_offer` / `refund_offer` calls, each instruction alone in its transaction, with compute units read
back from the confirmed transactions. `mainnet-escrow.json` holds the result (signatures and compute units only).
Running it again costs real SOL (rent and fees) and needs the four programs deployed: `RPC_URL` is a mainnet-beta RPC
endpoint, and `KEYS_DIR` (default `~/.config/typesol/mainnet`) holds `funder.json`, the paying keypair. Keep keys out
of this repository.

## Layout experiment

`layout/` compares one profile account stored five ways (TypeSOL's fixed layout, TypeSOL `@layout borsh`, Anchor with
Borsh and zero-copy, native and Pinocchio with fixed and Borsh layouts). It was used to choose TypeSOL's account
layouts and is kept for reference; its numbers are in `layout/results.json`, not in the main results.

## results.json

| Key | Written by | Holds |
| --- | --- | --- |
| `generated`, `rounds`, `toolchain`, `programs` | `run.ts` | mean compute units per instruction and binary sizes (KB) per implementation |
| `official` (`source`, `toolchain`, `generated`, `programs`) | `official.ts` | the same for each official example, plus `notes`, the hostile `probes` and the error each refusal returned (`probeErrors`) |

`toolchain` names the TypeSOL compiler (`@typesol/cli@<version>`, or a checkout) and how it compiled
(`typesolBuild`: clang, SBPF version, runtime header hash), the Anchor, Pinocchio and solana-program crate versions,
`cargo-build-sbf` with its platform-tools, and Node.

`results/<version>.json` keeps the results of every released compiler (a copy of `results.json` as committed for that
`@typesol/cli` version; `node scripts/archive.ts` writes it, CI checks it), so the numbers can be compared across
releases.

`node scripts/compare.ts <baseline.json> results.json [--official]` lists every number that differs between two
results and exits 1 if any does; CI runs it against the committed file (see docs/methodology.md, Regressions).

## License

MIT (see `LICENSE`). The official examples are cloned at build time from solana-developers/program-examples (MIT,
Solana Foundation); nothing of them is copied here.
