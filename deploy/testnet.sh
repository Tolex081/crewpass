#!/usr/bin/env bash
# Deploy CrewPass to NEAR testnet and initialise it. Free: uses faucet testnet NEAR.
# Needs near-cli-rs with the accounts' keys in the legacy keychain (~/.near-credentials).
#   deploy/testnet.sh
set -euo pipefail
cd "$(dirname "$0")/.."
source "$HOME/.cargo/env" 2>/dev/null || true
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/.cache/crewpass-target}"

CONTRACT=${CONTRACT:-crewpass.testnet}
CREATOR=${CREATOR:-crewpass-creator.testnet}
MINT_PRICE=${MINT_PRICE:-100000000000000000000000}   # 0.1 NEAR
COMMISSION_BPS=${COMMISSION_BPS:-1000}               # 10%
NET="network-config testnet"

(cd contract && cargo near build non-reproducible-wasm --no-abi >/dev/null)
WASM="$CARGO_TARGET_DIR/near/crewpass/crewpass.wasm"
echo "wasm sha256: $(sha256sum "$WASM" | cut -d' ' -f1) ($(stat -c%s "$WASM") bytes)"

near contract deploy "$CONTRACT" use-file "$WASM" \
  with-init-call new json-args "{\"creator\":\"$CREATOR\",\"mint_price\":\"$MINT_PRICE\",\"commission_bps\":$COMMISSION_BPS,\"name\":\"CrewPass\",\"symbol\":\"CREW\"}" \
  prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' \
  $NET sign-with-legacy-keychain send

near contract call-function as-read-only "$CONTRACT" config json-args '{}' $NET now
near contract call-function as-read-only "$CONTRACT" accounting json-args '{}' $NET now
