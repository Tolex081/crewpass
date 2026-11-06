#!/usr/bin/env bash
# Build both contracts to wasm, then run unit tests and NEAR sandbox tests.
# Needs Linux or WSL2 (the sandbox binary runs on Linux x86 / macOS ARM only).
#   scripts/test.sh            unit + sandbox
#   scripts/test.sh unit       unit tests only
set -euo pipefail
cd "$(dirname "$0")/.."
source "$HOME/.cargo/env" 2>/dev/null || true
# Build outside /mnt/c when running from a Windows folder in WSL: much faster.
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/.cache/crewpass-target}"

echo "== unit tests"
cargo test -p crewpass --lib -- --test-threads=4
[ "${1:-}" = "unit" ] && exit 0

echo "== build wasm"
(cd contract && cargo near build non-reproducible-wasm --no-abi)
(cd test-receiver && cargo near build non-reproducible-wasm --no-abi)
export CREWPASS_WASM="$CARGO_TARGET_DIR/near/crewpass/crewpass.wasm"
export RECEIVER_WASM="$CARGO_TARGET_DIR/near/test_receiver/test_receiver.wasm"
ls -la "$CREWPASS_WASM" "$RECEIVER_WASM"

echo "== sandbox tests"
cargo test -p crewpass --test sandbox -- --test-threads=1 --nocapture
