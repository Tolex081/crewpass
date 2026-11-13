#!/usr/bin/env bash
# Print testnet NEAR balance and storage use for the given accounts (read-only RPC).
#   scripts/balances.sh crewpass.testnet crewpass-alice.testnet ...
set -euo pipefail
RPC="${NEAR_RPC_URL:-https://rpc.testnet.fastnear.com}"
for a in "$@"; do
  curl -s "$RPC" -H 'Content-Type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"view_account\",\"finality\":\"final\",\"account_id\":\"$a\"}}" |
    python3 -c "
import sys, json
r = json.load(sys.stdin)
if 'result' in r:
    print(f\"$a  {int(r['result']['amount'])/1e24:.4f} NEAR  storage {r['result']['storage_usage']} B\")
else:
    print(f\"$a  error: {r.get('error', {}).get('cause', r.get('error'))}\")
"
done
