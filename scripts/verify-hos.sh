#!/usr/bin/env bash
# Check House of Stake (TLA) transfer behaviour for ourselves, in a local NEAR sandbox. Costs nothing.
#
# 1. Clone houseofstake/tla-contracts at bf0b65d (the commit registry.hos runs on mainnet),
#    build its contracts and run its own transfer tests.
# 2. Swap in the exact bytecode running on NEAR mainnet (read-only RPC) and run the same tests again.
#
# Needs Linux or WSL2, cargo-near, python3, git. Takes 15-30 minutes the first time.
# WARNING: the integration build is large. On a machine with ~8 GB for WSL it crashed WSL twice
# (Day 2). Give WSL more memory/swap in %UserProfile%\.wslconfig, or run it with CARGO_BUILD_JOBS=2.
set -euo pipefail
source "$HOME/.cargo/env" 2>/dev/null || true
WORK=${HOS_DIR:-$HOME/.cache/crewpass-hos}
RPC=${MAINNET_RPC:-https://rpc.mainnet.near.org}
COMMIT=bf0b65d

TESTS_MARKETPLACE="a_sale_pays_the_sellers_balance_out_with_the_name nft_transfer_rotates_the_wallet_and_the_registry_together a_transfer_is_refused_while_the_name_holds_a_listed_token nft_transfer_refuses_an_approval_id nft_transfer_by_a_non_owner_moves_nothing"
TESTS_PAYOUT="a_transfer_moves_the_payout_with_the_owner"

if [ ! -d "$WORK/.git" ]; then
  git clone -q https://github.com/houseofstake/tla-contracts.git "$WORK"
fi
cd "$WORK"
git fetch -q origin
git checkout -q "$COMMIT"
echo "== tla-contracts at $(git log --oneline -1)"

CONTRACTS=(hos-wallet wallet-impl-deployer registrar hos-extension mpc-recovery tla-registry registrar-opener)
DEV=(test-ft test-mpc test-staking-pool test-dapp registrar-opener-stub)
echo "== build contracts from source"
build() { (cd "$1" && cargo near build non-reproducible-wasm --locked --no-abi >/tmp/hos-build.log 2>&1) && echo "  built $1" || { echo "  FAILED $1"; tail -5 /tmp/hos-build.log; }; }
for c in "${CONTRACTS[@]}"; do build "contracts/$c"; done
for c in "${DEV[@]}"; do [ -d "dev-contracts/$c" ] && build "dev-contracts/$c"; done

run_tests() {
  local label=$1
  echo "== HoS transfer tests ($label)"
  # Show the tail on failure too: a filtered log hides compile errors.
  (cd integration && CARGO_TARGET_DIR="$WORK/target/integration" cargo test --test marketplace -- $TESTS_MARKETPLACE --test-threads=1 2>&1 | tail -30) || true
  (cd integration && CARGO_TARGET_DIR="$WORK/target/integration" cargo test --test payout -- $TESTS_PAYOUT 2>&1 | tail -15) || true
}
run_tests "built from source at $COMMIT"

echo "== swap in mainnet bytecode"
q() { curl -sS --max-time 60 "$RPC" -H 'content-type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":$1}"; }
save() { python3 -c "import sys,json,base64;r=json.load(sys.stdin)['result'];open(sys.argv[1],'wb').write(base64.b64decode(r['code_base64']));print('  ',sys.argv[1].split('/')[-1],r['hash'])" "$1"; }
T=target/near
q '{"request_type":"view_code","finality":"final","account_id":"registry.hos"}' | save $T/tla_registry/tla_registry.wasm
q '{"request_type":"view_code","finality":"final","account_id":"ext.hos"}'      | save $T/hos_extension/hos_extension.wasm
q '{"request_type":"view_code","finality":"final","account_id":"bot"}'          | save $T/registrar/registrar.wasm
q '{"request_type":"view_global_contract_code_by_account_id","finality":"final","account_id":"impl.hos"}' | save $T/hos_wallet/hos_wallet.wasm
q '{"request_type":"view_code","finality":"final","account_id":"impl.hos"}'     | save $T/wallet_impl_deployer/wallet_impl_deployer.wasm
q '{"request_type":"view_code","finality":"final","account_id":"rec.hos"}'      | save $T/mpc_recovery/mpc_recovery.wasm
run_tests "exact mainnet bytecode"
