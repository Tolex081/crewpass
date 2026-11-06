#!/usr/bin/env bash
# Live T9 proof on testnet: a hostile receiver contract gets pass #1 through nft_transfer_call and,
# while it owns the pass, tries to withdraw its vault, move it to an accomplice, and list it.
# Every attempt must be refused, the pass must come back, and the vault must be untouched.
#   deploy/attack-run.sh   > writes deploy/attack-run.md
set -uo pipefail
cd "$(dirname "$0")/.."
source "$HOME/.cargo/env" 2>/dev/null || true
command -v near >/dev/null || { echo "near-cli-rs not found" >&2; exit 1; }
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/.cache/crewpass-target}"
C=${CONTRACT:-crewpass.testnet}
EVIL=crewpass-evil.testnet ACCOMPLICE=crewpass-accomplice.testnet HOLDER=crewpass-carol.testnet REFERRER=crewpass-bob.testnet
NET="network-config testnet"
OUT=deploy/attack-run.md
EXPLORER=https://testnet.nearblocks.io/txns
clean() { sed 's/\x1b\[[0-9;]*m//g'; }
txid() { grep -oE 'Transaction ID: [A-Za-z0-9]+' | head -1 | awk '{print $3}'; }
view() { near contract call-function as-read-only "$1" "$2" json-args "$3" $NET now 2>/dev/null | clean | sed -n '/^[\[{]/,/^[]}]/p;/^"/p'; }
call() { # signer contract method args deposit -> prints cleaned output
  near contract call-function as-transaction "$2" "$3" json-args "$4" prepaid-gas '300.0 Tgas' \
    attached-deposit "$5" sign-as "$1" $NET sign-with-legacy-keychain send 2>&1 | clean
}

echo "== build and deploy the attacker contract to $EVIL" >&2
(cd test-receiver && cargo near build non-reproducible-wasm --no-abi >/dev/null)
WASM="$CARGO_TARGET_DIR/near/test_receiver/test_receiver.wasm"
DEPLOY=$(near contract deploy "$EVIL" use-file "$WASM" without-init-call $NET sign-with-legacy-keychain send 2>&1 | clean)
DEPLOY_TX=$(echo "$DEPLOY" | txid)
echo "  deploy tx $DEPLOY_TX" >&2
SET_TX=$(call "$EVIL" "$EVIL" set_accomplice "{\"accomplice\":\"$ACCOMPLICE\"}" '0 NEAR' | txid)

echo "== put money in pass #1's vault: $REFERRER mints with pass #1 as referrer" >&2
MINT_TX=$(call "$REFERRER" "$C" mint '{"referrer_token_id":"1"}' '0.1 NEAR' | txid)
VAULT_BEFORE=$(view "$C" vault_of '{"token_id":"1"}')
OWNER_BEFORE=$(view "$C" nft_token '{"token_id":"1"}' | grep -oE '"owner_id": "[^"]+"' | cut -d'"' -f4)
echo "  vault before: $VAULT_BEFORE, owner: $OWNER_BEFORE" >&2

{
  echo "# Live attack on CrewPass during nft_transfer_call (testnet)"
  echo
  echo "Threat **T9** in [THREAT_MODEL.md](../THREAT_MODEL.md). With standard NEP-171, \`nft_transfer_call\` makes the"
  echo "receiver the owner *before* calling it. A hostile receiver could use that moment to empty the vault,"
  echo "then hand the pass back. CrewPass locks the pass until \`nft_resolve_transfer\`."
  echo
  echo "Run $(date -u +%Y-%m-%dT%H:%M:%SZ) on \`$C\`. Attacker contract: \`$EVIL\` ([source](../test-receiver/src/lib.rs))."
  echo
  echo "Setup:"
  echo
  echo "- Attacker deployed: [${DEPLOY_TX:0:10}…]($EXPLORER/$DEPLOY_TX)"
  echo "- Accomplice set to \`$ACCOMPLICE\`: [${SET_TX:0:10}…]($EXPLORER/$SET_TX)"
  echo "- \`${REFERRER%.testnet}\` mints with pass #1 as referrer, so pass #1's vault holds 0.01 NEAR: [${MINT_TX:0:10}…]($EXPLORER/$MINT_TX)"
  echo "- Pass #1 owner before the attacks: \`$OWNER_BEFORE\`, vault: $VAULT_BEFORE yoctoNEAR"
  echo
  echo "| # | Attack while the receiver owns the pass | Pass #1 owner after | Vault after | Lock after | Transaction |"
  echo "|---|---|---|---|---|---|"
} > $OUT

n=0
for msg in steal_withdraw steal_transfer steal_list; do
  n=$((n+1))
  out=$(call "$HOLDER" "$C" nft_transfer_call "{\"receiver_id\":\"$EVIL\",\"token_id\":\"1\",\"msg\":\"$msg\"}" '1 yoctoNEAR')
  tx=$(echo "$out" | txid)
  owner=$(view "$C" nft_token '{"token_id":"1"}' | grep -oE '"owner_id": "[^"]+"' | cut -d'"' -f4)
  vault=$(view "$C" vault_of '{"token_id":"1"}')
  lock=$(view "$C" pass_info '{"token_id":"1"}' | grep -oE '"in_transfer_call": [a-z]+' | awk '{print $2}')
  case $msg in
    steal_withdraw) what="Withdraw the vault, then hand the pass back";;
    steal_transfer) what="Move the pass to the accomplice, then hand it back";;
    steal_list)     what="List the pass for sale, then hand it back";;
  esac
  printf '  %s tx=%s owner=%s vault=%s locked=%s\n' "$msg" "$tx" "$owner" "$vault" "$lock" >&2
  echo "| $n | $what | \`$owner\` | $vault | $lock | [${tx:0:10}…]($EXPLORER/$tx) |" >> $OUT
  [ -z "$tx" ] && echo "$out" | tail -25 >&2
done

{
  echo
  echo "## What the attacker recorded"
  echo
  echo "The attacker contract stores whether each of its calls into CrewPass succeeded (\`attempts\` view)."
  echo "\`succeeded: false\` means CrewPass refused it with \"pass is in the middle of nft_transfer_call\"."
  echo
  echo '```json'
  view "$EVIL" attempts '{}'
  echo '```'
  echo
  echo "## Pass #1 after all three attacks"
  echo
  echo '```json'
  view "$C" pass_info '{"token_id":"1"}'
  echo '```'
} >> $OUT
echo "written $OUT" >&2
