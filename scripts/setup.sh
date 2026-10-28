#!/usr/bin/env bash
# The TypeSOL side of the comparison, pinned: the TypeSOL repository at the tag of the @typesol/cli version in
# package.json, in vendor/typesol (its examples, the ports of the official examples, the Anchor twins and the
# third-party program binaries the ports load). Then the Anchor twins and this repository's native and Pinocchio
# programs are built.
#
#   bash scripts/setup.sh                 # needs git, Node 22+, Agave 3.1.10 (cargo-build-sbf, platform-tools v1.52)
#
# TYPESOL_REPO=<checkout> in run.ts / official.ts measures a checkout instead (see README); this script is not needed then.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
cd "$HERE"
[ -d node_modules/@typesol/cli ] || npm ci --no-audit --no-fund
VERSION="$(node -p 'require("@typesol/cli/package.json").version')"
VENDOR="$HERE/vendor/typesol"
if [ ! -d "$VENDOR/.git" ] || [ "$(git -C "$VENDOR" describe --tags --exact-match 2>/dev/null)" != "v$VERSION" ]; then
  rm -rf "$VENDOR"
  git clone --quiet --depth 1 --branch "v$VERSION" https://github.com/typesol/typesol.git "$VENDOR"
fi
echo "TypeSOL sources: v$VERSION"
# Metaplex Token Metadata, which the token ports call: dumped from mainnet-beta (the deployed version; devnet's can be
# newer). Its sha256 goes into results.json, since an upgrade changes the numbers of the instructions that call it.
TM="$VENDOR/test/programs/mpl_token_metadata.so"
for i in 1 2 3; do solana program dump -u "${SOLANA_RPC:-mainnet-beta}" metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s "$TM.new" >/dev/null && break; sleep 20; done
mv "$TM.new" "$TM"
echo "Token Metadata: $(shasum -a 256 "$TM" | cut -c1-16)…"
# The Anchor twins of examples/{counter,vault,escrow}.ts.
(cd "$VENDOR/bench/anchor" && cargo-build-sbf --tools-version v1.52)
# This repository's native and Pinocchio programs.
cargo-build-sbf --tools-version v1.52
