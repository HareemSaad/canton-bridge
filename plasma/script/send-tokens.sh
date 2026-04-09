#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLASMA_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# ─── config ───────────────────────────────────────────────────────────────────
RPC="${RPC_URL:-http://localhost:8545}"
AMOUNT="10000000000000000000"   # 10 tokens (18 decimals)
CANTON_CHAIN="$(cast keccak "CANTON")"
CANTON_RECIPIENT="${CANTON_RECIPIENT:-recipient::party-id-on-canton}"

# ─── load .env ────────────────────────────────────────────────────────────────
[[ -f "$PLASMA_DIR/.env" ]] && set -a && source "$PLASMA_DIR/.env" && set +a
[[ -n "${PRIVATE_KEY:-}" ]]     || { echo "✘ PRIVATE_KEY not set";         exit 1; }
[[ -n "${GATEWAY_ADDRESS:-}" ]] || { echo "✘ GATEWAY_ADDRESS not set";     exit 1; }

DEPLOYER=$(cast wallet address --private-key "$PRIVATE_KEY")
echo "▶  Sender   : $DEPLOYER"
echo "▶  Gateway  : $GATEWAY_ADDRESS"
echo "▶  RPC      : $RPC"
echo ""

# ─── 1. deploy mock ERC20 via cast send --create ─────────────────────────────
echo "▶  Deploying mock ERC20..."
BYTECODE=$(python3 -c "
import json
d = json.load(open('$PLASMA_DIR/out/Gateway.t.sol/MockERC20.json'))
print(d['bytecode']['object'])
")

DEPLOY_RECEIPT=$(cast send \
  --rpc-url "$RPC" \
  --private-key "$PRIVATE_KEY" \
  --create "$BYTECODE" \
  --json 2>/dev/null)

DEPLOY_TX=$(echo "$DEPLOY_RECEIPT" | python3 -c "import json,sys; print(json.load(sys.stdin)['transactionHash'])")
TOKEN_ADDR=$(cast receipt --rpc-url "$RPC" "$DEPLOY_TX" contractAddress)
echo "✔  Token deployed at: $TOKEN_ADDR"

# ─── 2. mint 10 tokens to sender ─────────────────────────────────────────────
echo "▶  Minting 10 tokens to $DEPLOYER..."
cast send --rpc-url "$RPC" --private-key "$PRIVATE_KEY" \
  "$TOKEN_ADDR" "mint(address,uint256)" "$DEPLOYER" "$AMOUNT" > /dev/null
echo "✔  Minted"

# ─── 3. whitelist token on gateway ───────────────────────────────────────────
echo "▶  Whitelisting token on Gateway..."
cast send --rpc-url "$RPC" --private-key "$PRIVATE_KEY" \
  "$GATEWAY_ADDRESS" "whiteListToken(address)" "$TOKEN_ADDR" > /dev/null
echo "✔  Token whitelisted"

# ─── 4. whitelist CANTON chain on gateway ────────────────────────────────────
echo "▶  Whitelisting CANTON chain on Gateway..."
cast send --rpc-url "$RPC" --private-key "$PRIVATE_KEY" \
  "$GATEWAY_ADDRESS" "whiteListChain(bytes32)" "$CANTON_CHAIN" > /dev/null
echo "✔  Chain whitelisted"

# ─── 5. approve gateway ──────────────────────────────────────────────────────
echo "▶  Approving Gateway..."
cast send --rpc-url "$RPC" --private-key "$PRIVATE_KEY" \
  "$TOKEN_ADDR" "approve(address,uint256)" "$GATEWAY_ADDRESS" "$AMOUNT" > /dev/null
echo "✔  Approved"

# ─── 6. lock tokens ──────────────────────────────────────────────────────────
echo "▶  Locking 10 tokens → Gateway..."
LOCK_RECEIPT=$(cast send \
  --rpc-url "$RPC" \
  --private-key "$PRIVATE_KEY" \
  --json \
  "$GATEWAY_ADDRESS" \
  "lock(address,uint256,string,bytes32)" \
  "$TOKEN_ADDR" "$AMOUNT" "$CANTON_RECIPIENT" "$CANTON_CHAIN")

TX_HASH=$(echo "$LOCK_RECEIPT" | python3 -c "import json,sys; print(json.load(sys.stdin)['transactionHash'])")
BLOCK=$(echo "$LOCK_RECEIPT"   | python3 -c "import json,sys; print(int(json.load(sys.stdin)['blockNumber'], 16))")

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ✔  locked 10 tokens"
echo "  Token     : $TOKEN_ADDR"
echo "  Gateway   : $GATEWAY_ADDRESS"
echo "  Recipient : $CANTON_RECIPIENT"
echo "  Chain     : CANTON ($CANTON_CHAIN)"
echo "  Tx hash   : $TX_HASH"
echo "  Block     : $BLOCK"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
