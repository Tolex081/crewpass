#!/usr/bin/env bash
# Deploy CrewPass V2 to NEW testnet accounts. V1 (crewpass.testnet) is not touched.
#   1. build the three wasm files and record their sha256
#   2. create crewpass-v2.testnet (registry) and crewpass-v2-target.testnet (test-only target)
#      through the free faucet if they do not exist yet, and top the registry up from demo accounts
#   3. publish the pass-account code as an immutable global contract (by hash)
#   4. deploy the registry and initialise it with that hash
# Needs near-cli-rs with the keys in the legacy keychain (~/.near-credentials). Testnet only.
set -euo pipefail
cd "$(dirname "$0")/.."
source "$HOME/.cargo/env" 2>/dev/null || true
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/.cache/crewpass-target}"
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-4}"

REGISTRY=${REGISTRY:-crewpass-v2.testnet}
TARGET=${TARGET:-crewpass-v2-target.testnet}
NET="network-config testnet"
RPC="${NEAR_RPC_URL:-https://rpc.testnet.fastnear.com}"

exists() {
  curl -s "$RPC" -H 'Content-Type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"view_account\",\"finality\":\"final\",\"account_id\":\"$1\"}}" |
    grep -q '"amount"'
}

echo "== build"
for c in pass-account contract-v2 test-target; do (cd "$c" && cargo near build non-reproducible-wasm --no-abi >/dev/null); done
PASS_WASM="$CARGO_TARGET_DIR/near/pass_account/pass_account.wasm"
REG_WASM="$CARGO_TARGET_DIR/near/crewpass_v2/crewpass_v2.wasm"
TARGET_WASM="$CARGO_TARGET_DIR/near/test_target/test_target.wasm"
PASS_HASH_HEX=$(sha256sum "$PASS_WASM" | cut -d' ' -f1)
PASS_HASH_B58=$(python3 -c "
import sys
h = bytes.fromhex('$PASS_HASH_HEX'); a = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
n = int.from_bytes(h, 'big'); s = ''
while n: n, r = divmod(n, 58); s = a[r] + s
print('1' * (len(h) - len(h.lstrip(b'\0'))) + s)")
REG_HASH_HEX=$(sha256sum "$REG_WASM" | cut -d' ' -f1)
echo "pass-account sha256 $PASS_HASH_HEX (base58 $PASS_HASH_B58), $(stat -c%s "$PASS_WASM") bytes"
echo "registry     sha256 $REG_HASH_HEX, $(stat -c%s "$REG_WASM") bytes"

echo "== accounts"
for acct in "$REGISTRY" "$TARGET"; do
  if exists "$acct"; then echo "$acct exists"; else
    near account create-account sponsor-by-faucet-service "$acct" autogenerate-new-keypair save-to-legacy-keychain $NET create
  fi
done
# Registry needs: ~3.6 NEAR code storage + ~4.4 NEAR burned to publish the global code + reserve.
for donor in ${DONORS:-crewpass-bob.testnet crewpass-evil.testnet crewpass-accomplice.testnet}; do
  near tokens "$donor" send-near "$REGISTRY" "${TOPUP:-4} NEAR" $NET sign-with-legacy-keychain send
done
scripts/balances.sh "$REGISTRY" "$TARGET"

echo "== publish pass-account code as a global contract (by hash, immutable)"
near contract deploy-as-global use-file "$PASS_WASM" as-global-hash "$REGISTRY" $NET sign-with-legacy-keychain send

echo "== deploy registry"
near contract deploy "$REGISTRY" use-file "$REG_WASM" \
  with-init-call new json-args "{\"pass_code_hash\":\"$PASS_HASH_B58\"}" \
  prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' $NET sign-with-legacy-keychain send
near contract deploy "$TARGET" use-file "$TARGET_WASM" without-init-call $NET sign-with-legacy-keychain send

near contract call-function as-read-only "$REGISTRY" config json-args '{}' $NET now
near contract call-function as-read-only "$REGISTRY" accounting json-args '{}' $NET now

cat > deploy/testnet-v2.json <<EOF
{
  "network": "testnet",
  "registry": "$REGISTRY",
  "pass_accounts": "<token_id>.$REGISTRY (created by the registry at mint, no access keys)",
  "pass_account_code": {
    "global_contract_hash_base58": "$PASS_HASH_B58",
    "wasm_sha256": "$PASS_HASH_HEX",
    "wasm_bytes": $(stat -c%s "$PASS_WASM")
  },
  "registry_code": { "wasm_sha256": "$REG_HASH_HEX", "wasm_bytes": $(stat -c%s "$REG_WASM") },
  "test_target": "$TARGET (test-only: slow chain, failing call, hostile nft_transfer_call receiver)",
  "source_commit": "$(git rev-parse --short HEAD)$(git diff --quiet || echo '+uncommitted')",
  "deployed_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "build": "cargo near build non-reproducible-wasm (rust 1.95.0, cargo-near 0.23.0, near-sdk 5.30.1)",
  "registry_full_access_key": "present (kept for fixes during the hackathon; THREAT_MODEL U1)",
  "keys": "not stored here; near-cli-rs legacy keychain in WSL"
}
EOF
cat deploy/testnet-v2.json
