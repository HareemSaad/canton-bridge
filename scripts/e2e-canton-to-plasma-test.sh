#!/usr/bin/env bash
# End-to-end Canton → Plasma withdrawal test.
# Prerequisites:
#   1. local-setup.sh is running (Anvil + Canton + graph-node + relayer-postgres)
#   2. Relayer is started: cd relayer && yarn start:dev
#   3. e2e-test.sh has been run (User1 must have a CIP56Holding to burn)
#
# What it does:
#   1. Finds User1's CIP56Holding contract ID on Canton
#   2. User1 submits a DepositToPlasma request (user-signed, targeting deployer EVM address)
#   3. Polls Canton until DepositToPlasmaEvent status = DepositCompleted
#      — relayer accepts the request (burns holding), submits withdrawFromCanton on EVM,
#        then marks the event Complete
#   4. Verifies the deployer's MockUSDC balance increased on EVM
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLASMA_DIR="$ROOT/plasma"
LOCAL_RPC="http://localhost:8545"
CANTON_JSON_API="http://localhost:7575"
TIMEOUT_SECS=180

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

[[ -n "${LOCAL_CANTON_PARTY_ID:-}"       ]] || die "LOCAL_CANTON_PARTY_ID not set in relayer/.env"
[[ -n "${LOCAL_TOKEN_CONFIG_ID:-}"       ]] || die "LOCAL_TOKEN_CONFIG_ID not set in relayer/.env"
[[ -n "${LOCAL_CANTON_BRIDGE_ADDRESS:-}" ]] || die "LOCAL_CANTON_BRIDGE_ADDRESS not set in relayer/.env"
[[ -n "${LOCAL_EVM_TOKEN_ADDRESS:-}"     ]] || die "LOCAL_EVM_TOKEN_ADDRESS not set in relayer/.env"

DEPLOYER=$(cast wallet address --private-key "$PRIVATE_KEY")
MOCK_TOKEN="$LOCAL_EVM_TOKEN_ADDRESS"

# Fingerprint for User1 (must match local-setup.sh)
USER1_FP_HEX="$(cast keccak "User1" | sed 's/0x//')"

# ─── helpers ──────────────────────────────────────────────────────────────────
fetch_active() {
  local offset
  offset=$(curl -sf "$CANTON_JSON_API/v2/state/ledger-end" \
    | python3 -c "import json,sys; print(json.load(sys.stdin)['offset'])")
  curl -sf -X POST "$CANTON_JSON_API/v2/state/active-contracts" \
    -H "Content-Type: application/json" \
    -d "{\"activeAtOffset\":\"$offset\",\"filter\":{\"filtersByParty\":{\"$LOCAL_CANTON_PARTY_ID\":{}}}}"
}

# ─── step 1: find User1's CIP56Holding ───────────────────────────────────────
log "Looking for User1's CIP56Holding on Canton..."

HOLDING_INFO=$(fetch_active | python3 -c "
import json, sys
data = json.load(sys.stdin)
for item in data:
    ev = (item.get('contractEntry') or {}).get('JsActiveContract') or {}
    ce = ev.get('createdEvent') or {}
    if 'CIP56Holding' not in (ce.get('templateId') or ''):
        continue
    args = ce.get('createArgument') or {}
    owner = args.get('owner', '')
    if 'User1' in owner:
        print(ce.get('contractId','') + '|' + args.get('amount','') + '|' + owner)
        break
" 2>/dev/null || true)

[[ -n "$HOLDING_INFO" ]] || die "No CIP56Holding found for User1 — run 'bash scripts/e2e-test.sh' first"

HOLDING_ID=$(echo "$HOLDING_INFO" | cut -d'|' -f1)
HOLDING_AMOUNT=$(echo "$HOLDING_INFO" | cut -d'|' -f2)
USER1_PARTY=$(echo "$HOLDING_INFO" | cut -d'|' -f3)

log "MockUSDC      : $MOCK_TOKEN"
log "Deployer (EVM): $DEPLOYER"
log "User1 party   : $USER1_PARTY"
log "Holding ID    : $HOLDING_ID"
log "Amount        : $HOLDING_AMOUNT"
echo ""

# ─── step 2: record EVM balance before ────────────────────────────────────────
log "Recording deployer MockUSDC balance before withdrawal..."
BALANCE_BEFORE=$(cast call "$MOCK_TOKEN" \
  "balanceOf(address)(uint256)" "$DEPLOYER" \
  --rpc-url "$LOCAL_RPC")
ok "Balance before: $BALANCE_BEFORE (raw units)"
echo ""

# ─── step 3: User1 submits DepositToPlasma request ───────────────────────────
# actAs=USER1_PARTY — User1 is the signatory on this contract.
# In the local sandbox (userId=sandbox) all allocated parties can sign.
log "User1 submitting DepositToPlasma request..."
DTP_TEMPLATE="#canton-bridge:Bridge.Contracts:DepositToPlasma"

curl -sf -X POST "$CANTON_JSON_API/v2/commands/submit-and-wait" \
  -H "Content-Type: application/json" \
  -d "{
    \"actAs\":[\"$USER1_PARTY\"],
    \"userId\":\"sandbox\",
    \"commandId\":\"e2e-dtp-$(date +%s)\",
    \"commands\":[{
      \"CreateCommand\":{
        \"templateId\":\"$DTP_TEMPLATE\",
        \"createArguments\":{
          \"user\":\"$USER1_PARTY\",
          \"issuer\":\"$LOCAL_CANTON_PARTY_ID\",
          \"holdingId\":\"$HOLDING_ID\",
          \"amount\":\"$HOLDING_AMOUNT\",
          \"evmRecipient\":\"$DEPLOYER\",
          \"fingerprint\":\"$USER1_FP_HEX\"
        }
      }
    }]
  }" > /dev/null
ok "DepositToPlasma contract created by User1"
echo ""

# ─── step 4: poll Canton for DepositToPlasmaEvent status = DepositCompleted ──
log "Polling Canton for DepositToPlasmaEvent completion (timeout ${TIMEOUT_SECS}s)..."
log "(Relayer will: Accept request → burn holding → submit EVM withdrawal → Complete)"
ELAPSED=0
EVENT_STATUS=""
while [[ $ELAPSED -lt $TIMEOUT_SECS ]]; do
  ACTIVE_POLL=$(fetch_active 2>/dev/null || echo "[]")

  EVENT_STATUS=$(echo "$ACTIVE_POLL" | python3 -c "
import json, sys
data = json.load(sys.stdin)
for item in data:
    ev = (item.get('contractEntry') or {}).get('JsActiveContract') or {}
    ce = ev.get('createdEvent') or {}
    if 'DepositToPlasmaEvent' not in (ce.get('templateId') or ''):
        continue
    status_json = json.dumps((ce.get('createArgument') or {}).get('status', ''))
    if 'DepositCompleted' in status_json:
        print('COMPLETED')
    elif 'DepositFailed' in status_json:
        print('FAILED')
    elif 'DepositPending' in status_json:
        print('PENDING')
    break
" 2>/dev/null || true)

  # Also check if DepositToPlasma request is still waiting (not yet accepted)
  DTP_PENDING=$(echo "$ACTIVE_POLL" | python3 -c "
import json, sys
data = json.load(sys.stdin)
count = sum(1 for i in data
    if 'DepositToPlasma' in str((i.get('contractEntry') or {}).get('JsActiveContract',{}).get('createdEvent',{}).get('templateId',''))
    and 'DepositToPlasmaEvent' not in str((i.get('contractEntry') or {}).get('JsActiveContract',{}).get('createdEvent',{}).get('templateId',''))
)
print(count)
" 2>/dev/null || echo "0")

  if [[ -z "$EVENT_STATUS" && "$DTP_PENDING" -gt 0 ]]; then
    printf "  [%3ds] DepositToPlasma pending acceptance by relayer\n" "$ELAPSED"
  else
    printf "  [%3ds] DepositToPlasmaEvent status=%s\n" "$ELAPSED" "${EVENT_STATUS:-<not yet visible>}"
  fi

  [[ "$EVENT_STATUS" == "COMPLETED" ]] && break
  [[ "$EVENT_STATUS" == "FAILED" ]] && die "DepositToPlasmaEvent marked FAILED by relayer"

  sleep 10
  ELAPSED=$((ELAPSED + 10))
done

echo ""
if [[ "$EVENT_STATUS" != "COMPLETED" ]]; then
  die "DepositToPlasmaEvent not completed after ${TIMEOUT_SECS}s (status=${EVENT_STATUS:-<none>})"
fi
ok "DepositToPlasmaEvent status = DepositCompleted"

# ─── step 5: verify EVM balance increased ─────────────────────────────────────
log "Verifying deployer MockUSDC balance on EVM..."
BALANCE_AFTER=$(cast call "$MOCK_TOKEN" \
  "balanceOf(address)(uint256)" "$DEPLOYER" \
  --rpc-url "$LOCAL_RPC")

# cast call appends human-readable annotations like "999000000 [9.99e8]" — strip them
parse_int() { echo "$1" | awk '{print $1}'; }
BEFORE_RAW=$(parse_int "$BALANCE_BEFORE")
AFTER_RAW=$(parse_int "$BALANCE_AFTER")
DIFF=$(python3 -c "print($AFTER_RAW - $BEFORE_RAW)")

ok "Balance before : $BEFORE_RAW"
ok "Balance after  : $AFTER_RAW"
ok "Received       : $DIFF raw units ($(python3 -c "print(f'{$DIFF/1_000_000:.6f}')") mUSDC)"

[[ "$DIFF" -gt 0 ]] || die "EVM balance did not increase — withdrawal may have failed silently"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
ok "E2E test passed — $(python3 -c "print(f'{$DIFF/1_000_000:.6f}')") mUSDC withdrawn from Canton to Plasma"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
