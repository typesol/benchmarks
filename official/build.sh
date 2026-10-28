#!/usr/bin/env bash
# Builds the Anchor, native and Pinocchio variants of the solana-developers/program-examples programs that official.ts
# compares, unmodified, at the pinned commit. Each variant is built the way the example's own CI builds it:
#   native / pinocchio: `cargo build-sbf --manifest-path <variant>/program/Cargo.toml` inside the repository's root
#                       workspace (its Cargo.lock), or the example's own workspace where it has one;
#   anchor:             the example's anchor/ workspace (anchor-lang 1.0.2; `anchor build` runs the same cargo-build-sbf).
# Output: official/deploy/<example>/<variant>/<crate>.so
#
#   ./official/build.sh            # clones the repository into official/program-examples when it is missing
#   ./official/build.sh counter    # only the examples whose path contains "counter"
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
COMMIT=de090195e4de698e150572c4f886c333323a64a5
SRC="${PROGRAM_EXAMPLES:-$HERE/program-examples}"
OUT="$HERE/deploy"
# One target directory for every workspace, so shared dependencies compile once.
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HERE/target}"

if [ ! -d "$SRC/.git" ]; then
  git clone https://github.com/solana-developers/program-examples "$SRC" || exit 1
fi
git -C "$SRC" checkout --quiet "$COMMIT" || exit 1
[ "$(git -C "$SRC" rev-parse HEAD)" = "$COMMIT" ] || { echo "program-examples is not at $COMMIT"; exit 1; }

EXAMPLES=(
  basics/account-data basics/checking-accounts basics/close-account basics/counter basics/create-account
  basics/cross-program-invocation basics/favorites basics/pda-rent-payer basics/processing-instructions
  basics/program-derived-addresses basics/realloc basics/transfer-sol
  tokens/create-token tokens/escrow tokens/pda-mint-authority tokens/transfer-tokens
  tokens/token-2022/default-account-state tokens/token-2022/mint-close-authority tokens/token-2022/non-transferable
)

failed=()
build() { # <example> <variant> <manifest>
  local name; name="$(basename "$1")"
  local dest="$OUT/$name/$2"
  mkdir -p "$dest"
  echo "== $1 ($2): $3"
  if ! (cd "$SRC" && cargo-build-sbf --manifest-path "$3" --sbf-out-dir "$dest" 2>&1 | tail -5); then failed+=("$1/$2"); fi
  ls "$dest"/*.so >/dev/null 2>&1 || failed+=("$1/$2 (no .so)")
}

for ex in "${EXAMPLES[@]}"; do
  [ $# -gt 0 ] && [[ "$ex" != *"$1"* ]] && continue
  for v in anchor native pinocchio; do
    for m in $(cd "$SRC" && find "$ex/$v" \( -path "$ex/$v/program/Cargo.toml" -o -path "$ex/$v/programs/*/Cargo.toml" \) | sort); do
      build "$ex" "$v" "$m"
    done
  done
done

if [ ${#failed[@]} -gt 0 ]; then
  printf 'failed: %s\n' "${failed[@]}"
  exit 1
fi
echo "built into $OUT"
