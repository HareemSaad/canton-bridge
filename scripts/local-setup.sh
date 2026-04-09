#!/usr/bin/env bash
set -euo pipefail

# ─── paths ────────────────────────────────────────────────────────────────────
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLASMA_DIR="$ROOT/plasma"
SUBGRAPH_DIR="$ROOT/subgraph"
CANTON_DIR="$ROOT/canton"

# ─── config ───────────────────────────────────────────────────────────────────
FORK_RPC="https://plasma-testnet.g.alchemy.com/v2/3zFAX-i0bLU7ZfCipH2EuDW02tB51Mt9"
LOCAL_RPC="http://localhost:8545"
ANVIL_PORT=8545
SUBGRAPH_NAME="gateway-local"
GRAPH_ADMIN="http://localhost:8020"
GRAPH_IPFS="http://localhost:5001"
GRAPH_QUERY="http://localhost:8000"
RELAYER_DB_CONTAINER="relayer-postgres"
RELAYER_DB_PORT=5433
RELAYER_DB_USER="relayer"
RELAYER_DB_PASS="relayer"
RELAYER_DB_NAME="relayer"
CANTON_GRPC_PORT=6865
CANTON_JSON_API_PORT=7575

# ─── helpers ──────────────────────────────────────────────────────────────────
log()  { echo "▶  $*"; }
ok()   { echo "✔  $*"; }
die()  { echo "✘  $*" >&2; exit 1; }

wait_for_port() {
  local name=$1 port=$2 retries=60
  log "Waiting for $name on port $port..."
  until nc -z localhost "$port" 2>/dev/null; do
    ((retries--)) || die "$name did not start in time"
    sleep 1
  done
  ok "$name is up"
}

wait_for_canton_ready() {
  local retries=60
  log "Waiting for Canton synchronizer to connect..."
  until curl -sf "http://localhost:${CANTON_JSON_API_PORT}/v2/state/connected-synchronizers" \
    2>/dev/null | python3 -c "
import json,sys
d=json.load(sys.stdin)
syncs=d.get('connectedSynchronizers',[])
sys.exit(0 if syncs else 1)
" 2>/dev/null; do
    ((retries--)) || die "Canton synchronizer did not connect in time"
    sleep 2
  done
  ok "Canton synchronizer connected"
}

cleanup() {
  if [[ -n "${ANVIL_PID:-}" ]]; then
    log "Stopping Anvil (PID $ANVIL_PID)..."
    kill "$ANVIL_PID" 2>/dev/null || true
  fi
  if [[ -n "${CANTON_PID:-}" ]]; then
    log "Stopping Canton sandbox (PID $CANTON_PID)..."
    kill "$CANTON_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# ─── load .env ────────────────────────────────────────────────────────────────
ENV_FILE="$PLASMA_DIR/.env"
[[ -f "$ENV_FILE" ]] || die ".env not found at $ENV_FILE"
set -a; source "$ENV_FILE"; set +a
[[ -n "${PRIVATE_KEY:-}" ]] || die "PRIVATE_KEY not set in .env"

# ─── 1. start anvil fork ──────────────────────────────────────────────────────
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
import json
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

# ─── 2b. deploy mock token + whitelist token and canton chain ─────────────────
log "Deploying MockERC20 and configuring Gateway whitelist..."
cd "$PLASMA_DIR"

GATEWAY_ADDRESS="$CONTRACT_ADDRESS" forge script script/SetupTest.s.sol:SetupTest \
  --rpc-url "$LOCAL_RPC" \
  --broadcast \
  2>&1 | tee /tmp/forge-setup.log

SETUP_BROADCAST="$PLASMA_DIR/broadcast/SetupTest.s.sol/$CHAIN_ID/run-latest.json"
[[ -f "$SETUP_BROADCAST" ]] || die "SetupTest broadcast not found: $SETUP_BROADCAST"

MOCK_TOKEN_ADDRESS=$(python3 -c "
import json
data = json.load(open('$SETUP_BROADCAST'))
tx = next(t for t in data['transactions'] if t['transactionType'] == 'CREATE')
print(tx['contractAddress'])
")
CANTON_CHAIN_ID=$(cast keccak "canton")

ok "MockERC20 deployed at $MOCK_TOKEN_ADDRESS"
ok "Token + canton chain whitelisted"

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
sleep 5
ok "graph-node stack is up"

# ─── 4b. start relayer postgres ──────────────────────────────────────────────
log "Starting relayer PostgreSQL..."
docker rm -f "$RELAYER_DB_CONTAINER" 2>/dev/null || true
docker run -d \
  --name "$RELAYER_DB_CONTAINER" \
  -e POSTGRES_USER="$RELAYER_DB_USER" \
  -e POSTGRES_PASSWORD="$RELAYER_DB_PASS" \
  -e POSTGRES_DB="$RELAYER_DB_NAME" \
  -p "$RELAYER_DB_PORT":5432 \
  postgres:14
wait_for_port "relayer-postgres" "$RELAYER_DB_PORT"
ok "Relayer PostgreSQL running on port $RELAYER_DB_PORT"

# ─── 4c. build and start Canton sandbox ──────────────────────────────────────
log "Building Canton DAR..."
cd "$CANTON_DIR"
daml build > /tmp/canton-build.log 2>&1
ok "Canton DAR built"

CANTON_DAR="$CANTON_DIR/.daml/dist/canton-bridge-1.0.0.dar"
[[ -f "$CANTON_DAR" ]] || die "Canton DAR not found at $CANTON_DAR"

lsof -ti:"$CANTON_GRPC_PORT" | xargs kill -9 2>/dev/null || true
lsof -ti:"$CANTON_JSON_API_PORT" | xargs kill -9 2>/dev/null || true

log "Starting Canton sandbox (gRPC :$CANTON_GRPC_PORT  JSON API :$CANTON_JSON_API_PORT)..."
daml sandbox \
  --port "$CANTON_GRPC_PORT" \
  --json-api-port "$CANTON_JSON_API_PORT" \
  --dar "$CANTON_DAR" \
  > /tmp/canton.log 2>&1 &
CANTON_PID=$!

wait_for_port "Canton gRPC" "$CANTON_GRPC_PORT"
wait_for_port "Canton JSON API" "$CANTON_JSON_API_PORT"
wait_for_canton_ready
ok "Canton sandbox running (PID $CANTON_PID)"

# ─── 4d. run Canton init script ───────────────────────────────────────────────
log "Running Canton init script (allocating parties)..."
cd "$CANTON_DIR"
daml script \
  --dar "$CANTON_DAR" \
  --script-name "Main:setup" \
  --ledger-host localhost \
  --ledger-port "$CANTON_GRPC_PORT" \
  --wall-clock-time \
  > /tmp/canton-script.log 2>&1
ok "Canton init script complete"

# ─── 4e. fetch BridgeOperator party ID ───────────────────────────────────────
log "Fetching BridgeOperator party ID from ledger..."
BRIDGE_OPERATOR_PARTY=$(daml ledger list-parties \
  --host localhost \
  --port "$CANTON_GRPC_PORT" \
  --json 2>/dev/null | python3 -c "
import json, sys
parties = json.load(sys.stdin)
for p in parties:
    party_id = p.get('party') or p.get('identifier', '')
    if 'BridgeOperator' in party_id:
        print(party_id)
        break
")
[[ -n "$BRIDGE_OPERATOR_PARTY" ]] || die "Failed to get BridgeOperator party ID — check /tmp/canton.log"
ok "BridgeOperator: $BRIDGE_OPERATOR_PARTY"

# ─── 4f. write relayer/.env ───────────────────────────────────────────────────
log "Writing relayer/.env..."
cat > "$ROOT/relayer/.env" <<ENVEOF
MODE=local

LOCAL_DATABASE_URL=postgresql://${RELAYER_DB_USER}:${RELAYER_DB_PASS}@localhost:${RELAYER_DB_PORT}/${RELAYER_DB_NAME}
LOCAL_SUBGRAPH_URL=${GRAPH_QUERY}/subgraphs/name/${SUBGRAPH_NAME}
LOCAL_PLASMA_RPC=${LOCAL_RPC}
LOCAL_CANTON_URL=http://localhost:${CANTON_JSON_API_PORT}
LOCAL_CANTON_PARTY_ID=${BRIDGE_OPERATOR_PARTY}
LOCAL_CANTON_TOKEN=
LOCAL_CANTON_USER_ID=sandbox

PROD_DATABASE_URL=
PROD_SUBGRAPH_URL=
PROD_PLASMA_RPC=
PROD_CANTON_URL=
PROD_CANTON_PARTY_ID=
PROD_CANTON_TOKEN=
PROD_CANTON_USER_ID=

POLL_INTERVAL_MS=30000
PENDING_CHECK_INTERVAL_MS=60000
SUBGRAPH_PAGE_SIZE=100
CANTON_TOKEN_DECIMALS=6
PORT=3000
NODE_ENV=development
ENVEOF
ok "Wrote relayer/.env"

# ─── 5. codegen + build ───────────────────────────────────────────────────────
log "Installing subgraph dependencies..."
cd "$SUBGRAPH_DIR"
npm install --silent

log "Running codegen..."
npm run codegen

log "Building subgraph..."
npm run build

# ─── 6. create + deploy subgraph ─────────────────────────────────────────────
log "Creating subgraph on local node..."
npm run create:local || true

log "Deploying subgraph..."
npx graph deploy \
  --node "$GRAPH_ADMIN" \
  --ipfs "$GRAPH_IPFS" \
  --version-label "v0.0.1" \
  "$SUBGRAPH_NAME"

# ─── done ─────────────────────────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Gateway      : $CONTRACT_ADDRESS"
echo "  MockERC20    : $MOCK_TOKEN_ADDRESS"
echo "  Canton chain : $CANTON_CHAIN_ID"
echo "  Chain ID     : $CHAIN_ID  |  Block: $BLOCK_NUMBER"
echo "  GraphQL      : $GRAPH_QUERY/subgraphs/name/$SUBGRAPH_NAME"
echo "  Relayer DB   : postgresql://$RELAYER_DB_USER:$RELAYER_DB_PASS@localhost:$RELAYER_DB_PORT/$RELAYER_DB_NAME"
echo "  Canton gRPC  : localhost:$CANTON_GRPC_PORT"
echo "  Canton HTTP  : http://localhost:$CANTON_JSON_API_PORT"
echo "  BridgeOp     : $BRIDGE_OPERATOR_PARTY"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "  Next steps:"
echo "  1. cd relayer && yarn install && yarn start:dev"
echo "  2. ./scripts/e2e-test.sh   (in a separate terminal)"
echo ""
echo "  Anvil (PID $ANVIL_PID) and Canton (PID $CANTON_PID) are running."
echo "  Press Ctrl-C to stop everything."
echo ""

trap - EXIT
wait "$ANVIL_PID" 2>/dev/null || true
