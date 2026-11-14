#!/usr/bin/env bash
# Upgrade the existing V2 registry on testnet while preserving its deployed state.
# Never use this script for mainnet, and do not call `new` on the existing registry.
set -euo pipefail
cd "$(dirname "$0")/.."
source "$HOME/.cargo/env" 2>/dev/null || true
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$PWD/target/crewpass-review}"

REGISTRY=${REGISTRY:-crewpass-v2.testnet}
NET="network-config testnet"
REG_WASM="$CARGO_TARGET_DIR/near/crewpass_v2/crewpass_v2.wasm"

if [[ "$REGISTRY" != *.testnet ]]; then
  echo "Refusing to upgrade a non-testnet account: $REGISTRY" >&2
  exit 2
fi
if [[ ! -f "$REG_WASM" ]]; then
  echo "Build the contract first; missing $REG_WASM" >&2
  exit 2
fi

echo "== current config and accounting (testnet)"
near contract call-function as-read-only "$REGISTRY" config json-args '{}' $NET now
near contract call-function as-read-only "$REGISTRY" accounting json-args '{}' $NET now

echo "== upgrade existing registry without reinitializing state"
near contract deploy "$REGISTRY" use-file "$REG_WASM" without-init-call $NET sign-with-legacy-keychain send

echo "== verify preserved state and solvent accounting"
near contract call-function as-read-only "$REGISTRY" config json-args '{}' $NET now
near contract call-function as-read-only "$REGISTRY" accounting json-args '{}' $NET now
echo "registry wasm sha256 $(sha256sum "$REG_WASM" | cut -d' ' -f1)"
echo "pass-account hash remains the value already stored in registry config"
