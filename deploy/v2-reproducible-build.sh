#!/usr/bin/env bash
# Build CrewPass V2 contracts inside the pinned cargo-near Docker image and verify
# that each build is reproducible. Run from a clean, committed checkout.
set -euo pipefail
cd "$(dirname "$0")/.."
source "$HOME/.cargo/env" 2>/dev/null || true

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Commit or stash changes before a reproducible build; cargo-near requires a clean checkout." >&2
  exit 2
fi
if [[ -n "$(git ls-files --others --exclude-standard)" ]]; then
  echo "Remove or ignore untracked files before a reproducible build." >&2
  exit 2
fi

export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$PWD/target/crewpass-review}"
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-4}"
for crate in pass-account contract-v2 test-target; do
  echo "== reproducible build: $crate"
  (cd "$crate" && cargo near build reproducible-wasm)
done

echo "== artifact hashes"
for wasm in \
  "$CARGO_TARGET_DIR/near/pass_account/pass_account.wasm" \
  "$CARGO_TARGET_DIR/near/crewpass_v2/crewpass_v2.wasm" \
  "$CARGO_TARGET_DIR/near/test_target/test_target.wasm"; do
  sha256sum "$wasm"
done
