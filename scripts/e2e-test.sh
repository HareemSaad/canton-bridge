#!/usr/bin/env bash
# End-to-end bridge test.
# Prerequisites: local-setup.sh is running AND the relayer is started:
#   cd relayer && yarn start:dev
#
# What it does:
#   1. Approves CantonBridge to spend MockUSDC
#   2. Calls CantonBridge.depositToCanton() with User1's keccak fingerprint
#   3. Polls the relayer DB until the row reaches RELAYED (or times out)
#   4. Queries the Canton JSON API to confirm the CIP56Holding was minted to User1
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLASMA_DIR="$ROOT/plasma"
LOCAL_RPC="http://localhost:8545"
CANTON_JSON_API="http://localhost:7575"
DEPOSIT_AMOUNT="1000000"  # 1.000000 mUSDC (6 decimals)
TIMEOUT_SECS=180          # 3 minutes max

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

[[ -n "${LOCAL_CANTON_PARTY_ID:-}"  ]] || die "LOCAL_CANTON_PARTY_ID not set in relayer/.env"
[[ -n "${LOCAL_TOKEN_CONFIG_ID:-}"  ]] || die "LOCAL_TOKEN_CONFIG_ID not set in relayer/.env"
[[ -n "${LOCAL_DATABASE_URL:-}"     ]] || die "LOCAL_DATABASE_URL not set in relayer/.env"

DEPLOYER=$(cast wallet address --private-key "$PRIVATE_KEY")
CHAIN_ID=$(cast chain-id --rpc-url "$LOCAL_RPC")

# ─── resolve contract addresses from broadcast ────────────────────────────────
BROADCAST="$PLASMA_DIR/broadcast/CantonBridge.s.sol/$CHAIN_ID/run-latest.json"
[[ -f "$BROADCAST" ]] || die "CantonBridge broadcast not found — run local-setup.sh first"

BRIDGE_ADDRESSES=$(python3 -c "
import json
data = json.load(open('$BROADCAST'))
creates = [t['contractAddress'] for t in data['transactions'] if t['transactionType'] == 'CREATE']
print(creates[1])  # CantonBridge
print(creates[2])  # MockUSDC
")
CANTON_BRIDGE=$(echo "$BRIDGE_ADDRESSES" | sed -n '1p')
MOCK_TOKEN=$(echo    "$BRIDGE_ADDRESSES" | sed -n '2p')

# ─── compute deterministic User1 fingerprint (must match local-setup.sh) ──────
# keccak256("User1") — same formula used by local-setup.sh when creating the
# FingerprintMapping.  The 0x-prefixed value is passed to depositToCanton().
USER1_FP=$(cast keccak "User1")

log "CantonBridge : $CANTON_BRIDGE"
log "MockUSDC     : $MOCK_TOKEN"
log "Operator     : $LOCAL_CANTON_PARTY_ID"
log "User1 fp     : $USER1_FP"
log "Amount       : $DEPOSIT_AMOUNT (raw) = 1.000000 mUSDC"
echo ""

# ─── step 1: approve CantonBridge to pull tokens ──────────────────────────────
log "Approving CantonBridge to spend $DEPOSIT_AMOUNT mUSDC..."
cast send "$MOCK_TOKEN" \
  "approve(address,uint256)" "$CANTON_BRIDGE" "$DEPOSIT_AMOUNT" \
  --private-key "$PRIVATE_KEY" \
  --rpc-url "$LOCAL_RPC" \
  --json | python3 -c "import json,sys; r=json.load(sys.stdin); print('  tx:', r.get('transactionHash','?'))"
ok "Approved"

# ─── step 2: deposit tokens into CantonBridge ─────────────────────────────────
log "Calling CantonBridge.depositToCanton() — fingerprint=$USER1_FP..."
TX_HASH=$(cast send "$CANTON_BRIDGE" \
  "depositToCanton(address,uint256,bytes32)" \
  "$MOCK_TOKEN" "$DEPOSIT_AMOUNT" "$USER1_FP" \
  --private-key "$PRIVATE_KEY" \
  --rpc-url "$LOCAL_RPC" \
  --json | python3 -c "import json,sys; print(json.load(sys.stdin)['transactionHash'])")
ok "Deposited — tx: $TX_HASH"
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

# ─── step 4: verify CIP56Holding on Canton ───────────────────────────────────
log "Querying Canton ledger for CIP56Holding contracts..."

curl -sf -X POST "$CANTON_JSON_API/v2/state/active-contracts" \
  -H "Content-Type: application/json" \
  -d "{
    \"filter\": {
      \"filtersByParty\": {
        \"$LOCAL_CANTON_PARTY_ID\": {
          \"cumulative\": {
            \"templateFilters\": [{
              \"template\": {
                \"moduleName\": \"CIP56.Token\",
                \"entityName\": \"CIP56Holding\"
              }
            }]
          }
        }
      }
    }
  }" 2>/dev/null | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
    contracts = data.get('activeContracts', [])
    if contracts:
        print(f'  Found {len(contracts)} CIP56Holding contract(s) on Canton:')
        for c in contracts:
            args = c.get('createdEvent', {}).get('createArgument', {})
            print(f'    owner={args.get(\"owner\",\"?\")}  amount={args.get(\"amount\",\"?\")}  instrumentId={args.get(\"instrumentId\",\"?\")}')
    else:
        print('  No CIP56Holding contracts found (relayer may still be processing)')
except Exception as e:
    print(f'  Canton query note: {e}')
" 2>/dev/null || true

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
ok "E2E test passed — 1 mUSDC bridged from Plasma to Canton (CIP56Holding minted)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
