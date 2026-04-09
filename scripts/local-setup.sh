#!/usr/bin/env bash
set -euo pipefail

# ─── paths ────────────────────────────────────────────────────────────────────
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLASMA_DIR="$ROOT/plasma"
SUBGRAPH_DIR="$ROOT/subgraph"

# ─── config ───────────────────────────────────────────────────────────────────
FORK_RPC="https://plasma-testnet.g.alchemy.com/v2/3zFAX-i0bLU7ZfCipH2EuDW02tB51Mt9"
LOCAL_RPC="http://localhost:8545"
ANVIL_PORT=8545
SUBGRAPH_NAME="gateway-local"
GRAPH_ADMIN="http://localhost:8020"
GRAPH_IPFS="http://localhost:5001"
GRAPH_QUERY="http://localhost:8000"

# ─── helpers ──────────────────────────────────────────────────────────────────
log()  { echo "▶  $*"; }
ok()   { echo "✔  $*"; }
die()  { echo "✘  $*" >&2; exit 1; }

wait_for_port() {
  local name=$1 port=$2 retries=30
  log "Waiting for $name on port $port..."
  until nc -z localhost "$port" 2>/dev/null; do
    ((retries--)) || die "$name did not start in time"
    sleep 1
  done
  ok "$name is up"
}

cleanup() {
  if [[ -n "${ANVIL_PID:-}" ]]; then
    log "Stopping Anvil (PID $ANVIL_PID)..."
    kill "$ANVIL_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# ─── load .env ────────────────────────────────────────────────────────────────
ENV_FILE="$PLASMA_DIR/.env"
[[ -f "$ENV_FILE" ]] || die ".env not found at $ENV_FILE"
set -a; source "$ENV_FILE"; set +a
[[ -n "${PRIVATE_KEY:-}" ]] || die "PRIVATE_KEY not set in .env"

# ─── 1. start anvil fork ──────────────────────────────────────────────────────
# kill any leftover Anvil on the same port
lsof -ti:"$ANVIL_PORT" | xargs kill -9 2>/dev/null || true

log "Starting Anvil fork of Plasma testnet..."
anvil \
  --fork-url "$FORK_RPC" \
  --port "$ANVIL_PORT" \
  --block-time 1 \
  > /tmp/anvil.log 2>&1 &
ANVIL_PID=$!

wait_for_port "Anvil" "$ANVIL_PORT"
CHAIN_ID=$(cast chain-id --rpc-url "$LOCAL_RPC")
ok "Anvil running — chain ID: $CHAIN_ID  (PID $ANVIL_PID)"

# ─── 2. fund deployer & deploy gateway ───────────────────────────────────────
DEPLOYER=$(cast wallet address --private-key "$PRIVATE_KEY" 2>/dev/null || \
           python3 -c "from eth_account import Account; print(Account.from_key('$PRIVATE_KEY').address)" 2>/dev/null || \
           cast wallet address "$PRIVATE_KEY")

log "Funding deployer $DEPLOYER with 100 ETH..."
cast rpc anvil_setBalance "$DEPLOYER" 0x56BC75E2D63100000 --rpc-url "$LOCAL_RPC" > /dev/null

log "Deploying Gateway contract..."
cd "$PLASMA_DIR"

forge script script/Gateway.s.sol:DeployScript \
  --rpc-url "$LOCAL_RPC" \
  --broadcast \
  2>&1 | tee /tmp/forge-deploy.log

BROADCAST="$PLASMA_DIR/broadcast/Gateway.s.sol/$CHAIN_ID/run-latest.json"
[[ -f "$BROADCAST" ]] || die "Broadcast file not found: $BROADCAST"

CONTRACT_ADDRESS=$(python3 -c "
import json, sys
data = json.load(open('$BROADCAST'))
tx = next(t for t in data['transactions'] if t['transactionType'] == 'CREATE')
print(tx['contractAddress'])
")

BLOCK_HEX=$(python3 -c "
import json
data = json.load(open('$BROADCAST'))
print(data['receipts'][0]['blockNumber'])
")
BLOCK_NUMBER=$(printf "%d" "$BLOCK_HEX")

ok "Gateway deployed at $CONTRACT_ADDRESS (block $BLOCK_NUMBER)"

# ─── 3. patch subgraph.yaml ───────────────────────────────────────────────────
log "Patching subgraph/subgraph.yaml..."
YAML="$SUBGRAPH_DIR/subgraph.yaml"
[[ -f "$YAML" ]] || die "subgraph.yaml not found at $YAML"

python3 - <<PYEOF
import re

with open('$YAML') as f:
    content = f.read()

content = re.sub(
    r'address: "0x[0-9a-fA-F]+"(\s*# replace after deployment)?',
    'address: "$CONTRACT_ADDRESS"',
    content
)
content = re.sub(
    r'startBlock: \d+(\s*# replace with deployment block)?',
    'startBlock: $BLOCK_NUMBER',
    content
)

with open('$YAML', 'w') as f:
    f.write(content)
PYEOF

ok "subgraph.yaml updated"

# ─── 4. start graph-node stack ────────────────────────────────────────────────
log "Starting graph-node Docker stack..."
cd "$SUBGRAPH_DIR"
docker compose up -d

wait_for_port "graph-node admin" 8020
# extra settle time for graph-node internal init
sleep 5
ok "graph-node stack is up"

# ─── 5. codegen + build ───────────────────────────────────────────────────────
log "Installing subgraph dependencies..."
npm install --silent

log "Running codegen..."
npm run codegen

log "Building subgraph..."
npm run build

# ─── 6. create + deploy subgraph ─────────────────────────────────────────────
log "Creating subgraph on local node..."
npm run create:local || true   # ignore if already exists

log "Deploying subgraph..."
npx graph deploy \
  --node "$GRAPH_ADMIN" \
  --ipfs "$GRAPH_IPFS" \
  --version-label "v0.0.1" \
  "$SUBGRAPH_NAME"

# ─── done ─────────────────────────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Gateway  : $CONTRACT_ADDRESS"
echo "  Chain ID : $CHAIN_ID"
echo "  Block    : $BLOCK_NUMBER"
echo "  GraphQL  : $GRAPH_QUERY/subgraphs/name/$SUBGRAPH_NAME"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "  Anvil is still running (PID $ANVIL_PID)."
echo "  Press Ctrl-C to stop it."
echo ""

# keep script alive so anvil stays up
trap - EXIT
wait "$ANVIL_PID" 2>/dev/null || true
