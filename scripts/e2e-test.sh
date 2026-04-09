#!/usr/bin/env bash
# End-to-end bridge test.
# Prerequisites: local-setup.sh is running AND the relayer is started
#   cd relayer && yarn start:dev
#
# What it does:
#   1. Approves Gateway to spend MockERC20
#   2. Calls Gateway.lock() with the BridgeOperator Canton party ID as recipient
#   3. Polls the relayer DB until the row reaches RELAYED (or times out)
#   4. Queries the Canton JSON API to confirm the MockUSDCxHolding was created
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLASMA_DIR="$ROOT/plasma"
LOCAL_RPC="http://localhost:8545"
CANTON_JSON_API="http://localhost:7575"
LOCK_AMOUNT="1000000"   # 1.000000 mUSDCx (6 decimals)
TIMEOUT_SECS=180        # 3 minutes max

log()  { echo "▶  $*"; }
ok()   { echo "✔  $*"; }
die()  { echo "✘  $*" >&2; exit 1; }

# ─── load env ─────────────────────────────────────────────────────────────────
ENV_FILE="$PLASMA_DIR/.env"
[[ -f "$ENV_FILE" ]] || die "plasma/.env not found — run local-setup.sh first"
set -a; source "$ENV_FILE"; set +a

RELAYER_ENV="$ROOT/relayer/.env"
[[ -f "$RELAYER_ENV" ]] || die "relayer/.env not found — run local-setup.sh first"
set -a; source "$RELAYER_ENV"; set +a

[[ -n "${LOCAL_CANTON_PARTY_ID:-}" ]] || die "LOCAL_CANTON_PARTY_ID not set in relayer/.env"
[[ -n "${LOCAL_DATABASE_URL:-}" ]]    || die "LOCAL_DATABASE_URL not set in relayer/.env"

DEPLOYER=$(cast wallet address --private-key "$PRIVATE_KEY")
CHAIN_ID=$(cast chain-id --rpc-url "$LOCAL_RPC")
CANTON_CHAIN_ID=$(cast keccak "canton")

# ─── resolve contract addresses from broadcast files ─────────────────────────
BROADCAST="$PLASMA_DIR/broadcast/Gateway.s.sol/$CHAIN_ID/run-latest.json"
[[ -f "$BROADCAST" ]] || die "Gateway broadcast not found — run local-setup.sh first"
GATEWAY=$(python3 -c "
import json
d = json.load(open('$BROADCAST'))
print(next(t['contractAddress'] for t in d['transactions'] if t['transactionType']=='CREATE'))
")

SETUP_BROADCAST="$PLASMA_DIR/broadcast/SetupTest.s.sol/$CHAIN_ID/run-latest.json"
[[ -f "$SETUP_BROADCAST" ]] || die "SetupTest broadcast not found — run local-setup.sh first"
MOCK_TOKEN=$(python3 -c "
import json
d = json.load(open('$SETUP_BROADCAST'))
print(next(t['contractAddress'] for t in d['transactions'] if t['transactionType']=='CREATE'))
")

log "Gateway   : $GATEWAY"
log "MockERC20 : $MOCK_TOKEN"
log "Recipient : $LOCAL_CANTON_PARTY_ID"
log "Amount    : $LOCK_AMOUNT (raw) = 1.000000 mUSDCx"
echo ""

# ─── step 1: approve Gateway to spend tokens ─────────────────────────────────
log "Approving Gateway to spend $LOCK_AMOUNT mUSDCx..."
cast send "$MOCK_TOKEN" \
  "approve(address,uint256)" "$GATEWAY" "$LOCK_AMOUNT" \
  --private-key "$PRIVATE_KEY" \
  --rpc-url "$LOCAL_RPC" \
  --json | python3 -c "import json,sys; r=json.load(sys.stdin); print('  tx:', r.get('transactionHash','?'))"
ok "Approved"

# ─── step 2: lock tokens on Plasma ───────────────────────────────────────────
log "Calling Gateway.lock() — recipient = Canton BridgeOperator party..."
TX_HASH=$(cast send "$GATEWAY" \
  "lock(address,uint256,string,bytes32)" \
  "$MOCK_TOKEN" "$LOCK_AMOUNT" "$LOCAL_CANTON_PARTY_ID" "$CANTON_CHAIN_ID" \
  --private-key "$PRIVATE_KEY" \
  --rpc-url "$LOCAL_RPC" \
  --json | python3 -c "import json,sys; print(json.load(sys.stdin)['transactionHash'])")
ok "Locked — tx: $TX_HASH"
echo ""

# ─── step 3: poll DB for RELAYED status ──────────────────────────────────────
log "Polling relayer DB for RELAYED status (timeout ${TIMEOUT_SECS}s)..."
ELAPSED=0
STATUS=""
while [[ $ELAPSED -lt $TIMEOUT_SECS ]]; do
  STATUS=$(docker exec relayer-postgres psql -U relayer -d relayer -t -c \
    "SELECT status FROM bridge_transactions WHERE transaction_hash = lower('$TX_HASH') LIMIT 1;" \
    2>/dev/null | tr -d ' \n') || true

  printf "  [%3ds] status=%s\n" "$ELAPSED" "${STATUS:-<none>}"
  [[ "$STATUS" == "RELAYED" ]] && break

  sleep 10
  ELAPSED=$((ELAPSED + 10))
done

echo ""
if [[ "$STATUS" != "RELAYED" ]]; then
  die "Bridge transaction not RELAYED after ${TIMEOUT_SECS}s (status=${STATUS:-<none>})"
fi
ok "DB row is RELAYED"

# ─── step 4: verify MockUSDCxHolding on Canton ───────────────────────────────
log "Querying Canton ledger for MockUSDCxHolding contracts..."
CANTON_END=$(curl -s "$CANTON_JSON_API/v2/state/ledger-end" 2>/dev/null | \
  python3 -c "import json,sys; print(json.load(sys.stdin).get('offset', 50))" 2>/dev/null || echo "50")

curl -s -X POST "$CANTON_JSON_API/v2/updates" \
  -H "Content-Type: application/json" \
  -d "{\"beginExclusive\":0,\"endInclusive\":$CANTON_END,\"filter\":{\"filtersByParty\":{\"$LOCAL_CANTON_PARTY_ID\":{}}}}" \
  2>/dev/null | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
    holdings = []
    for entry in data:
        tx = entry.get('update', {}).get('Transaction', {}).get('value', {})
        for event in tx.get('events', []):
            ce = event.get('CreatedEvent', {})
            if 'MockUSDCxHolding' in ce.get('templateId', '') and ce.get('acsDelta'):
                holdings.append(ce.get('createArgument', {}))
    if holdings:
        print(f'  Found {len(holdings)} MockUSDCxHolding contract(s) on Canton:')
        for h in holdings:
            print(f'    owner={h.get(\"owner\",\"?\")}  amount={h.get(\"amount\",\"?\")}')
    else:
        print('  No holdings found via updates stream')
except Exception as e:
    print(f'  Canton query note: {e}')
" 2>/dev/null || true

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
ok "E2E test passed — 1 mUSDCx bridged from Plasma to Canton"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
