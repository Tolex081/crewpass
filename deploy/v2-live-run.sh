#!/usr/bin/env bash
# The CrewPass V2 journey, live on testnet, with every transaction recorded, including the refused
# ones. Run once on a fresh registry (it assumes programme 1, passes #1/#2 and event 1).
#   deploy/v2-live-run.sh   > writes deploy/v2-live-run.md
set -uo pipefail
cd "$(dirname "$0")/.."
source "$HOME/.cargo/env" 2>/dev/null || true
C=${REGISTRY:-crewpass-v2.testnet}
T=${TARGET:-crewpass-v2-target.testnet}
ALICE=crewpass-alice.testnet BOB=crewpass-bob.testnet CAROL=crewpass-carol.testnet
CREATOR=crewpass-creator.testnet VISITOR=crewpass-accomplice.testnet
ACCT="1.$C"
NET="network-config testnet"
RPC="${NEAR_RPC_URL:-https://rpc.testnet.fastnear.com}"
OUT=deploy/v2-live-run.md
EXPLORER=https://testnet.nearblocks.io/txns
FAILS=0

{
  echo "# CrewPass V2 live run on NEAR testnet"
  echo
  echo "Registry \`$C\`, run $(date -u +%Y-%m-%dT%H:%M:%SZ) by \`deploy/v2-live-run.sh\`. Every row is a real testnet"
  echo "transaction. Refused rows show the contract's own error. Pass #1 controls the keyless account \`$ACCT\`."
  echo
  echo "| # | Who | Action | Expected | Result | Transaction |"
  echo "|---|---|---|---|---|---|"
} > $OUT
n=0
record() { # who expect desc out
  local who=$1 expect=$2 desc=$3 out=$4 tx result err mark
  n=$((n+1))
  tx=$(echo "$out" | grep -oE 'Transaction ID: [A-Za-z0-9]+' | head -1 | awk '{print $3}')
  [ -z "$tx" ] && tx=$(echo "$out" | grep -oE 'txns/[A-Za-z0-9]+|transaction/[A-Za-z0-9]+' | head -1 | sed 's#.*/##')
  if [ -z "$tx" ]; then
    result="no transaction sent"
  elif echo "$out" | grep -qiE 'Smart contract panicked|Failed transaction|ExecutionError|Error:'; then
    err=$(echo "$out" | grep -oE 'Smart contract panicked: [^"\\]*' | head -1 | sed 's/Smart contract panicked: //')
    result="refused: ${err:-see tx}"
  else
    result="ok"
  fi
  mark=PASS
  { [ "$expect" = ok ] && [ "$result" != ok ]; } && mark=UNEXPECTED
  { [ "$expect" = refused ] && [ "${result%%:*}" != refused ]; } && mark=UNEXPECTED
  [ $mark = UNEXPECTED ] && FAILS=$((FAILS+1))
  printf '%2d %-10s %-60s expected=%-8s %s  %s\n' $n "${who%%.testnet}" "${desc:0:60}" "$expect" "$result" "$mark" >&2
  echo "| $n | ${who%.testnet} | $desc | $expect | $result | [${tx:0:10}…]($EXPLORER/$tx) |" >> $OUT
  [ $mark = UNEXPECTED ] && echo "$out" | tail -25 >&2
}
call() { # contract who expect method args deposit desc
  local out
  out=$(near contract call-function as-transaction "$1" "$4" json-args "$5" \
        prepaid-gas '300.0 Tgas' attached-deposit "$6" sign-as "$2" $NET sign-with-legacy-keychain send 2>&1 | sed 's/\x1b\[[0-9;]*m//g')
  record "$2" "$3" "$7" "$out"
}
step() { call "$C" "$@"; }
view() { near contract call-function as-read-only "$C" "$1" json-args "$2" $NET now 2>/dev/null | sed -n '/^{/,/^}/p;/^"/p;/^null/p'; }
account() { # balance (NEAR), keys, global code hash
  curl -s "$RPC" -H 'Content-Type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"view_account\",\"finality\":\"final\",\"account_id\":\"$1\"}}" |
    python3 -c "import sys,json; r=json.load(sys.stdin)['result']; print(f\"balance {int(r['amount'])/1e24:.4f} NEAR, global_contract_hash {r.get('global_contract_hash')}\")"
  curl -s "$RPC" -H 'Content-Type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"view_access_key_list\",\"finality\":\"final\",\"account_id\":\"$1\"}}" |
    python3 -c "import sys,json; print('access keys:', len(json.load(sys.stdin)['result']['keys']))"
}
NEAR=000000000000000000000000

echo "== 1. creator launches a programme" >&2
step $CREATOR ok create_programme '{"name":"Study Crew","description":"A small learning community for people starting to build on NEAR.","mint_price":"100000000000000000000000","referral_bps":1000,"member_share_bps":5000}' '0.1 NEAR' 'Creator launches programme 1 (0.1 NEAR mint, 10% referral, 50% of tickets to members)'

echo "== 2-3. Alice mints; the pass gets its own account" >&2
step $ALICE ok mint '{"programme_id":1}' '0.1 NEAR' "Alice mints pass #1; the registry creates \`$ACCT\` (no keys, pass-account code by hash)"
ACCOUNT_AFTER_MINT=$(account "$ACCT")
step $BOB ok mint '{"programme_id":1,"referrer_token_id":"1"}' '0.1 NEAR' "Bob mints pass #2 through pass #1: 0.01 NEAR commission paid into \`$ACCT\`"
step $ALICE refused mint '{"programme_id":1,"referrer_token_id":"1"}' '0.1 NEAR' 'Alice tries to refer herself'

echo "== 4-5. tickets; revenue reaches the pass account" >&2
step $CREATOR ok create_event '{"programme_id":1,"title":"Live study session","price":"50000000000000000000000","capacity":50,"points":30,"starts_at_ms":"0"}' '0.1 NEAR' 'Creator creates event 1 (0.05 NEAR ticket, 30 points)'
step $ALICE ok buy_ticket '{"event_id":1,"token_id":"1"}' '0.05 NEAR' 'Alice buys a ticket with pass #1 attached'
step $VISITOR ok buy_ticket '{"event_id":1}' '0.05 NEAR' 'A visitor without a pass buys a ticket'
step $VISITOR refused buy_ticket '{"event_id":1}' '0.05 NEAR' 'The visitor tries to buy a second ticket'
step $BOB ok claim_rewards '{"token_id":"1"}' '0 NEAR' "Anyone pushes pass #1's ticket revenue (2 × 0.0125 NEAR) into \`$ACCT\`"
step $BOB refused claim_rewards '{"token_id":"1"}' '0 NEAR' 'Claiming the same rewards again'

echo "== 6. achievements and tier upgrade" >&2
step $ALICE refused check_in '{"event_id":1,"token_id":"1"}' '0.01 NEAR' 'Alice tries to check herself in'
step $CREATOR ok check_in '{"event_id":1,"token_id":"1"}' '0.01 NEAR' 'Creator checks pass #1 in: +30 points → Silver (nft_metadata_update)'
step $CREATOR ok award_achievement '{"token_id":"1","code":"first-project","points":45}' '0.01 NEAR' 'Creator awards "first-project" (+45) → Gold (nft_metadata_update)'
step $CREATOR refused award_achievement '{"token_id":"1","code":"first-project","points":45}' '0.01 NEAR' 'Same achievement twice'
step $ALICE ok account_transfer "{\"token_id\":\"1\",\"receiver_id\":\"$ALICE\",\"amount\":\"5000000000000000000000\"}" '1 yoctoNEAR' "Alice, the holder, withdraws 0.005 NEAR from \`$ACCT\`"
TIER_BEFORE_SALE=$(view pass_info '{"token_id":"1"}')

echo "== 7-10. sale to Carol; Alice is locked out" >&2
step $ALICE ok list '{"token_id":"1","price":"500000000000000000000000"}' '0.01 NEAR' 'Alice lists pass #1 for 0.5 NEAR (listing 1)'
step $ALICE refused account_transfer "{\"token_id\":\"1\",\"receiver_id\":\"$ALICE\",\"amount\":\"1000\"}" '1 yoctoNEAR' 'Alice tries to empty the account while listed'
step $CAROL refused buy '{"token_id":"1","listing_id":"999"}' '0.5 NEAR' 'Carol buys with a listing id she did not see'
step $CAROL ok buy '{"token_id":"1","listing_id":"1"}' '0.5 NEAR' "Carol buys pass #1: ownership and control of \`$ACCT\` move in this receipt"
step $ALICE refused account_transfer "{\"token_id\":\"1\",\"receiver_id\":\"$ALICE\",\"amount\":\"1000\"}" '1 yoctoNEAR' 'Alice (old owner) tries to withdraw from the account'
step $ALICE refused account_call "{\"token_id\":\"1\",\"receiver_id\":\"$T\",\"method_name\":\"record\",\"args\":\"\",\"deposit\":\"0\",\"gas\":\"20000000000000\"}" '1 yoctoNEAR' 'Alice tries to make the account call another contract'
BORSH=$(python3 -c "
import base64, struct
r = b'$ALICE'; print(base64.b64encode(struct.pack('<I', len(r)) + r + (1000).to_bytes(16, 'little')).decode())")
out=$(near contract call-function as-transaction "$ACCT" execute_transfer base64-args "$BORSH" prepaid-gas '30.0 Tgas' attached-deposit '0 NEAR' sign-as $ALICE $NET sign-with-legacy-keychain send 2>&1 | sed 's/\x1b\[[0-9;]*m//g')
record $ALICE refused "Alice calls \`$ACCT\` directly (no registry)" "$out"
step $ALICE refused list '{"token_id":"1","price":"1"}' '0.01 NEAR' 'Alice tries to relist the pass'
step $ALICE refused nft_transfer "{\"token_id\":\"1\",\"receiver_id\":\"$ALICE\"}" '1 yoctoNEAR' 'Alice tries to move the pass'

echo "== 11. Carol uses the inherited membership and account" >&2
step $CAROL ok account_transfer "{\"token_id\":\"1\",\"receiver_id\":\"$CAROL\",\"amount\":\"10000000000000000000000\"}" '1 yoctoNEAR' "Carol withdraws 0.01 NEAR from \`$ACCT\`"
ARGS=$(python3 -c "import base64,json; print(base64.b64encode(json.dumps({'note':'hello from pass 1'}).encode()).decode())")
step $CAROL ok account_call "{\"token_id\":\"1\",\"receiver_id\":\"$T\",\"method_name\":\"record\",\"args\":\"$ARGS\",\"deposit\":\"1000\",\"gas\":\"20000000000000\"}" '1 yoctoNEAR' "Carol makes \`$ACCT\` call another contract as itself"
step $CAROL refused nft_transfer "{\"token_id\":\"1\",\"receiver_id\":\"2.$C\"}" '1 yoctoNEAR' "Carol tries to send the pass to a pass account (would freeze it)"
step $CAROL ok nft_transfer_call "{\"token_id\":\"1\",\"receiver_id\":\"$T\",\"msg\":\"steal_account\"}" '1 yoctoNEAR' 'Hostile receiver gets the pass via nft_transfer_call and tries to drain the account (pass returned)'
step $CAROL ok nft_transfer_call "{\"token_id\":\"1\",\"receiver_id\":\"$T\",\"msg\":\"steal_list\"}" '1 yoctoNEAR' 'Hostile receiver tries to list the pass mid-transfer (pass returned)'

{
  echo
  echo "Unexpected results in this run: **$FAILS**."
  echo
  echo "## Pass account right after mint"
  echo
  echo '```'
  echo "$ACCOUNT_AFTER_MINT"
  echo '```'
  echo
  echo "## Pass #1 before the sale (Alice)"
  echo
  echo '```json'
  echo "$TIER_BEFORE_SALE"
  echo '```'
  echo
  echo "## State after the run"
  echo
  echo '```json'
  echo "// pass_info(\"1\")"; view pass_info '{"token_id":"1"}'
  echo "// nft_token(\"1\").metadata.title / extra"
  near contract call-function as-read-only "$C" nft_token json-args '{"token_id":"1"}' $NET now 2>/dev/null | grep -E '"(title|extra|owner_id)"'
  echo "// accounting()"; view accounting '{}'
  echo "// $T attempts() (hostile receiver)"
  near contract call-function as-read-only "$T" attempts json-args '{}' $NET now 2>/dev/null | sed -n '/^\[/,/^\]/p'
  echo "// $T calls() (made by the pass account)"
  near contract call-function as-read-only "$T" calls json-args '{}' $NET now 2>/dev/null | sed -n '/^\[/,/^\]/p'
  echo '```'
  echo
  echo '```'
  echo "$ACCT now:"; account "$ACCT"
  echo '```'
} >> $OUT
echo "written $OUT; unexpected: $FAILS" >&2
