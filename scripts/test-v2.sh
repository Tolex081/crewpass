#!/usr/bin/env bash
# CrewPass V2: unit tests, wasm builds, then NEAR sandbox tests (real global contract + keyless
# pass accounts on a local nearcore 2.14 node). Needs Linux or WSL2.
#   scripts/test-v2.sh          unit + sandbox
#   scripts/test-v2.sh unit     unit tests only
set -euo pipefail
cd "$(dirname "$0")/.."
source "$HOME/.cargo/env" 2>/dev/null || true
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/.cache/crewpass-target}"
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-4}"

echo "== unit tests"
cargo test -p pass-account -p crewpass-v2 --lib -- --test-threads=4
[ "${1:-}" = "unit" ] && exit 0

echo "== build wasm"
for c in pass-account contract-v2 test-target; do
  (cd "$c" && cargo near build non-reproducible-wasm --no-abi)
done
export PASS_ACCOUNT_WASM="$CARGO_TARGET_DIR/near/pass_account/pass_account.wasm"
export REGISTRY_WASM="$CARGO_TARGET_DIR/near/crewpass_v2/crewpass_v2.wasm"
export TARGET_WASM="$CARGO_TARGET_DIR/near/test_target/test_target.wasm"
sha256sum "$PASS_ACCOUNT_WASM" "$REGISTRY_WASM" "$TARGET_WASM"
ls -la "$PASS_ACCOUNT_WASM" "$REGISTRY_WASM" "$TARGET_WASM"

echo "== sandbox tests"
cargo test -p crewpass-v2 --test sandbox -- --test-threads=2 --nocapture
