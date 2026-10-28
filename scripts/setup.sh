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
# Metaplex and SPL program binaries some ports load (fetched from the chain, as the TypeSOL repository's CI does).
(cd "$VENDOR" && for i in 1 2 3; do bash scripts/fetch-programs.sh devnet && break; sleep 20; done)
# The Anchor twins of examples/{counter,vault,escrow}.ts.
(cd "$VENDOR/bench/anchor" && cargo-build-sbf --tools-version v1.52)
# This repository's native and Pinocchio programs.
cargo-build-sbf --tools-version v1.52
