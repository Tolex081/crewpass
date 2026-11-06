#!/usr/bin/env bash
# Run the CrewPass story live on testnet and record every transaction, including the refused ones.
#   deploy/live-run.sh  > writes deploy/live-run.md
# Run once on a fresh deployment (it assumes the first two passes will be #1 and #2).
set -uo pipefail
cd "$(dirname "$0")/.."
source "$HOME/.cargo/env" 2>/dev/null || true
command -v near >/dev/null || { echo "near-cli-rs not found" >&2; exit 1; }
C=${CONTRACT:-crewpass.testnet}
ALICE=crewpass-alice.testnet BOB=crewpass-bob.testnet CAROL=crewpass-carol.testnet CREATOR=crewpass-creator.testnet
NET="network-config testnet"
OUT=deploy/live-run.md
EXPLORER=https://testnet.nearblocks.io/txns

echo "# CrewPass live run on NEAR testnet" > $OUT
echo >> $OUT
echo "Contract \`$C\`, run $(date -u +%Y-%m-%dT%H:%M:%SZ). Every step is a real testnet transaction; refused steps show the contract's own error." >> $OUT
echo >> $OUT
echo "| # | Who | Action | Expected | Result | Transaction |" >> $OUT
echo "|---|---|---|---|---|---|" >> $OUT
n=0
step() { # who expect method args deposit description
  local who=$1 expect=$2 method=$3 args=$4 deposit=$5 desc=$6 out tx result err
  n=$((n+1))
  out=$(near contract call-function as-transaction "$C" "$method" json-args "$args" \
        prepaid-gas '300.0 Tgas' attached-deposit "$deposit" sign-as "$who" $NET sign-with-legacy-keychain send 2>&1 \
        | sed 's/\x1b\[[0-9;]*m//g')
  tx=$(echo "$out" | grep -oE 'Transaction ID: [A-Za-z0-9]+' | head -1 | awk '{print $3}')
  [ -z "$tx" ] && tx=$(echo "$out" | grep -oE 'transaction/[A-Za-z0-9]+|txns/[A-Za-z0-9]+' | head -1 | sed 's#.*/##')
  if [ -z "$tx" ]; then
    result="no transaction sent"          # never count a step as ok without a transaction
  elif echo "$out" | grep -qiE 'Smart contract panicked|Failed transaction|ExecutionError|Error:'; then
    err=$(echo "$out" | grep -oE 'Smart contract panicked: [^"\\]*' | head -1 | sed 's/Smart contract panicked: //')
    result="refused: ${err:-see tx}"
  else
    result="ok"
  fi
  local mark="PASS"; { [ "$expect" = ok ] && [ "$result" != ok ]; } && mark="UNEXPECTED"
  { [ "$expect" = refused ] && [ "${result%%:*}" != refused ]; } && mark="UNEXPECTED"
  printf '%2d %-10s %-28s expected=%-8s %s  %s\n' $n "${who%%.testnet}" "$method" "$expect" "$result" "$mark" >&2
  echo "| $n | ${who%.testnet} | $desc | $expect | $result | [${tx:0:10}…]($EXPLORER/$tx) |" >> $OUT
  [ "$mark" = UNEXPECTED ] && echo "$out" | tail -20 >&2
}
view() { near contract call-function as-read-only "$C" "$1" json-args "$2" $NET now 2>/dev/null | sed -n '/^{/,/^}/p;/^"/p'; }

step $ALICE ok      mint     '{}'                                      '0.1 NEAR'  'Mint pass #1 (no referrer)'
step $BOB   ok      mint     '{"referrer_token_id":"1"}'               '0.1 NEAR'  'Mint pass #2 with pass #1 as referrer: 0.01 NEAR into pass #1 vault'
step $ALICE refused mint     '{"referrer_token_id":"1"}'               '0.1 NEAR'  'Self-referral with own pass #1'
step $ALICE ok      list     '{"token_id":"1","price":"1000000000000000000000000"}' '0.01 NEAR' 'List pass #1 for 1 NEAR'
step $ALICE refused withdraw '{"token_id":"1"}'                        '1 yoctoNEAR' 'Seller withdraws while listed'
step $CAROL refused buy      '{"token_id":"1","expected_min_vault":"10000000000000000000001"}' '1 NEAR' 'Buy expecting more than the vault holds'
step $CAROL ok      buy      '{"token_id":"1","expected_min_vault":"10000000000000000000000"}' '1 NEAR' 'Buy pass #1 for 1 NEAR, vault 0.01 NEAR comes with it'
step $ALICE refused withdraw '{"token_id":"1"}'                        '1 yoctoNEAR' 'Old owner withdraws after the sale'
step $ALICE refused nft_transfer '{"token_id":"1","receiver_id":"crewpass-alice.testnet"}' '1 yoctoNEAR' 'Old owner moves the pass after the sale'
step $ALICE refused list     '{"token_id":"1","price":"1"}'            '0.01 NEAR' 'Old owner relists after the sale'
step $CAROL ok      withdraw '{"token_id":"1"}'                        '1 yoctoNEAR' 'New owner withdraws the 0.01 NEAR vault'
step $CREATOR ok    claim    '{}'                                      '0 NEAR'    'Creator claims mint income'

{
  echo
  echo "## State after the run"
  echo
  echo '```json'
  echo "// pass_info(\"1\")"; view pass_info '{"token_id":"1"}'
  echo "// accounting()";    view accounting '{}'
  echo '```'
} >> $OUT
echo "written $OUT" >&2
