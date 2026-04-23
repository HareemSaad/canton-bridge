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
SUBGRAPH_NAME="canton-bridge-local"
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

canton_submit() {
  # Usage: canton_submit <commandId> <actor_party> <json_commands_array>
  local cmd_id=$1 actor=$2 cmds=$3
  curl -sf -X POST "http://localhost:${CANTON_JSON_API_PORT}/v2/commands/submit-and-wait" \
    -H "Content-Type: application/json" \
    -d "{\"actAs\":[\"$actor\"],\"userId\":\"sandbox\",\"commandId\":\"$cmd_id\",\"commands\":$cmds}" \
    > /dev/null
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

# ─── 2. fund deployer + deploy CantonBridge stack ─────────────────────────────
DEPLOYER=$(cast wallet address --private-key "$PRIVATE_KEY" 2>/dev/null || \
           python3 -c "from eth_account import Account; print(Account.from_key('$PRIVATE_KEY').address)" 2>/dev/null || \
           cast wallet address "$PRIVATE_KEY")

log "Funding deployer $DEPLOYER with 100 ETH..."
cast rpc anvil_setBalance "$DEPLOYER" 0x56BC75E2D63100000 --rpc-url "$LOCAL_RPC" > /dev/null

log "Deploying CantonBridge + TokenRegistry + MockUSDC..."
cd "$PLASMA_DIR"

# Deployer also acts as relayer for local testing
RELAYER_ADDRESS="$DEPLOYER" CIP56_INSTRUMENT="MockUSDC::canton" \
forge script script/CantonBridge.s.sol:DeployCantonBridge \
  --rpc-url "$LOCAL_RPC" \
  --broadcast \
  2>&1 | tee /tmp/forge-deploy.log

BROADCAST="$PLASMA_DIR/broadcast/CantonBridge.s.sol/$CHAIN_ID/run-latest.json"
[[ -f "$BROADCAST" ]] || die "Broadcast file not found: $BROADCAST"

# Extract addresses from broadcast (CREATE transactions in order: registry, bridge, token)
BRIDGE_ADDRESSES=$(python3 -c "
import json
data = json.load(open('$BROADCAST'))
creates = [t['contractAddress'] for t in data['transactions'] if t['transactionType'] == 'CREATE']
print(creates[0])  # TokenRegistry
print(creates[1])  # CantonBridge
print(creates[2])  # MockUSDC
")

TOKEN_REGISTRY_ADDRESS=$(echo "$BRIDGE_ADDRESSES" | sed -n '1p')
CANTON_BRIDGE_ADDRESS=$(echo  "$BRIDGE_ADDRESSES" | sed -n '2p')
MOCK_USDC_ADDRESS=$(echo      "$BRIDGE_ADDRESSES" | sed -n '3p')

BLOCK_HEX=$(python3 -c "
import json
data = json.load(open('$BROADCAST'))
print(data['receipts'][0]['blockNumber'])
")
BLOCK_NUMBER=$(printf "%d" "$BLOCK_HEX")

ok "TokenRegistry : $TOKEN_REGISTRY_ADDRESS"
ok "CantonBridge  : $CANTON_BRIDGE_ADDRESS (block $BLOCK_NUMBER)"
ok "MockUSDC      : $MOCK_USDC_ADDRESS"

# ─── 3. patch subgraph.yaml ───────────────────────────────────────────────────
log "Patching subgraph/subgraph.yaml with CantonBridge address..."
YAML="$SUBGRAPH_DIR/subgraph.yaml"
[[ -f "$YAML" ]] || die "subgraph.yaml not found at $YAML"

python3 - <<PYEOF
import re, sys

with open('$YAML') as f:
    content = f.read()

# Patch only the CantonBridge data source block (first occurrence)
# Replace the placeholder address in the CantonBridge section
content = re.sub(
    r'(name: CantonBridge.*?address: )"0x[0-9a-fA-F]+"(\s*# replace after deployment)?',
    r'\g<1>"$CANTON_BRIDGE_ADDRESS"',
    content,
    count=1,
    flags=re.DOTALL
)
content = re.sub(
    r'(name: CantonBridge.*?startBlock: )\d+(\s*# replace with deployment block)?',
    r'\g<1>$BLOCK_NUMBER',
    content,
    count=1,
    flags=re.DOTALL
)
# Also update Gateway startBlock to avoid scanning from genesis
content = re.sub(
    r'(name: Gateway.*?startBlock: )\d+(\s*# same as CantonBridge to avoid scanning from genesis)?',
    r'\g<1>$BLOCK_NUMBER',
    content,
    count=1,
    flags=re.DOTALL
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
log "Running Canton init script (allocating parties + contracts)..."
cd "$CANTON_DIR"
daml script \
  --dar "$CANTON_DAR" \
  --script-name "Main:setup" \
  --ledger-host localhost \
  --ledger-port "$CANTON_GRPC_PORT" \
  --wall-clock-time \
  2>&1 | tee /tmp/canton-script.log
ok "Canton init script complete"

# ─── 4e. parse contract IDs from script output ────────────────────────────────
log "Parsing Canton contract IDs from script output..."

parse_id() {
  local key=$1
  python3 -c "
import re, sys
with open('/tmp/canton-script.log') as f:
    content = f.read()
m = re.search(r'${key}=([0-9a-fA-F][^\"\s\\\\]+)', content)
print(m.group(1).strip() if m else '')
"
}

TOKEN_CONFIG_ID=$(parse_id "TOKEN_CONFIG_ID")
BRIDGE_STATE_ID=$(parse_id "BRIDGE_STATE_ID")

[[ -n "$TOKEN_CONFIG_ID" ]] || die "Could not parse TOKEN_CONFIG_ID from canton-script.log"
[[ -n "$BRIDGE_STATE_ID" ]] || die "Could not parse BRIDGE_STATE_ID from canton-script.log"

ok "TOKEN_CONFIG_ID : $TOKEN_CONFIG_ID"
ok "BRIDGE_STATE_ID : $BRIDGE_STATE_ID"

# ─── 4f. fetch party IDs from ledger ─────────────────────────────────────────
log "Fetching party IDs from ledger..."
PARTIES_JSON=$(daml ledger list-parties \
  --host localhost --port "$CANTON_GRPC_PORT" --json 2>/dev/null)

extract_party() {
  local hint=$1
  echo "$PARTIES_JSON" | python3 -c "
import json, sys
parties = json.load(sys.stdin)
for p in parties:
    pid = p.get('party') or p.get('identifier', '')
    if '$hint' in pid:
        print(pid); break
"
}

BRIDGE_OPERATOR_PARTY=$(extract_party "BridgeOperator")
USER1_PARTY=$(extract_party "User1")
USER2_PARTY=$(extract_party "User2")

[[ -n "$BRIDGE_OPERATOR_PARTY" ]] || die "Failed to get BridgeOperator party ID"
[[ -n "$USER1_PARTY"           ]] || die "Failed to get User1 party ID"
ok "BridgeOperator : $BRIDGE_OPERATOR_PARTY"
ok "User1          : $USER1_PARTY"
ok "User2          : $USER2_PARTY"

# ─── 4g. compute deterministic fingerprints and create FingerprintMappings ───
# FingerprintMappings are created here (not in Main.daml) so we can use the
# real keccak256 fingerprints directly — no placeholder Remove+Create round-trip.
log "Creating FingerprintMappings with keccak256 fingerprints..."
USER1_FP_BYTES32=$(cast keccak "User1")   # 0xabc...
USER2_FP_BYTES32=$(cast keccak "User2")
USER1_FP_HEX="${USER1_FP_BYTES32#0x}"     # strip 0x for Daml Text storage
USER2_FP_HEX="${USER2_FP_BYTES32#0x}"

TEMPLATE_ID="#canton-bridge:Common.FingerprintAuth:FingerprintMapping"

canton_submit "create-fp-user1" "$BRIDGE_OPERATOR_PARTY" \
  "[{\"CreateCommand\":{\"templateId\":\"$TEMPLATE_ID\",\"createArguments\":{\"issuer\":\"$BRIDGE_OPERATOR_PARTY\",\"userParty\":\"$USER1_PARTY\",\"fingerprint\":\"$USER1_FP_HEX\",\"evmAddress\":null}}}]"
ok "User1 FingerprintMapping created (fp=$USER1_FP_BYTES32)"

canton_submit "create-fp-user2" "$BRIDGE_OPERATOR_PARTY" \
  "[{\"CreateCommand\":{\"templateId\":\"$TEMPLATE_ID\",\"createArguments\":{\"issuer\":\"$BRIDGE_OPERATOR_PARTY\",\"userParty\":\"$USER2_PARTY\",\"fingerprint\":\"$USER2_FP_HEX\",\"evmAddress\":null}}}]"
ok "User2 FingerprintMapping created (fp=$USER2_FP_BYTES32)"

# ─── 4i. write relayer/.env ───────────────────────────────────────────────────
log "Writing relayer/.env..."
cat > "$ROOT/relayer/.env" <<ENVEOF
MODE=local

LOCAL_DATABASE_URL=postgresql://${RELAYER_DB_USER}:${RELAYER_DB_PASS}@localhost:${RELAYER_DB_PORT}/${RELAYER_DB_NAME}
LOCAL_SUBGRAPH_URL=${GRAPH_QUERY}/subgraphs/name/${SUBGRAPH_NAME}
LOCAL_PLASMA_RPC=${LOCAL_RPC}
LOCAL_RELAYER_PRIVATE_KEY=${PRIVATE_KEY}
LOCAL_CANTON_BRIDGE_ADDRESS=${CANTON_BRIDGE_ADDRESS}
LOCAL_EVM_TOKEN_ADDRESS=${MOCK_USDC_ADDRESS}
LOCAL_CHAIN_ID=${CHAIN_ID}
LOCAL_CANTON_URL=http://localhost:${CANTON_JSON_API_PORT}
LOCAL_CANTON_PARTY_ID=${BRIDGE_OPERATOR_PARTY}
LOCAL_CANTON_TOKEN=
LOCAL_CANTON_USER_ID=sandbox
LOCAL_TOKEN_CONFIG_ID=${TOKEN_CONFIG_ID}
LOCAL_BRIDGE_STATE_ID=${BRIDGE_STATE_ID}

PROD_DATABASE_URL=
PROD_SUBGRAPH_URL=
PROD_PLASMA_RPC=
PROD_RELAYER_PRIVATE_KEY=
PROD_CANTON_BRIDGE_ADDRESS=
PROD_EVM_TOKEN_ADDRESS=
PROD_CHAIN_ID=
PROD_CANTON_URL=
PROD_CANTON_PARTY_ID=
PROD_CANTON_TOKEN=
PROD_CANTON_USER_ID=
PROD_TOKEN_CONFIG_ID=
PROD_BRIDGE_STATE_ID=

POLL_INTERVAL_MS=30000
PENDING_CHECK_INTERVAL_MS=60000
LOCAL_WITHDRAWAL_POLL_MS=30000
SUBGRAPH_PAGE_SIZE=100
CANTON_TOKEN_DECIMALS=6
PORT=3000
NODE_ENV=development
ENVEOF
ok "Wrote relayer/.env"

# ─── 5. codegen + build subgraph ──────────────────────────────────────────────
log "Installing subgraph dependencies..."
cd "$SUBGRAPH_DIR"
npm install --silent

log "Running codegen..."
npm run codegen

log "Building subgraph..."
npm run build

# ─── 6. create + deploy subgraph ─────────────────────────────────────────────
log "Creating subgraph on local node..."
npx graph create --node "$GRAPH_ADMIN" "$SUBGRAPH_NAME" 2>/dev/null || true

log "Deploying subgraph..."
npx graph deploy \
  --node "$GRAPH_ADMIN" \
  --ipfs "$GRAPH_IPFS" \
  --version-label "v0.0.1" \
  "$SUBGRAPH_NAME"

# ─── done ─────────────────────────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  CantonBridge  : $CANTON_BRIDGE_ADDRESS"
echo "  TokenRegistry : $TOKEN_REGISTRY_ADDRESS"
echo "  MockUSDC      : $MOCK_USDC_ADDRESS"
echo "  Chain ID      : $CHAIN_ID  |  Start block: $BLOCK_NUMBER"
echo "  GraphQL       : $GRAPH_QUERY/subgraphs/name/$SUBGRAPH_NAME"
echo "  Relayer DB    : postgresql://$RELAYER_DB_USER:$RELAYER_DB_PASS@localhost:$RELAYER_DB_PORT/$RELAYER_DB_NAME"
echo "  Canton gRPC   : localhost:$CANTON_GRPC_PORT"
echo "  Canton HTTP   : http://localhost:$CANTON_JSON_API_PORT"
echo "  BridgeOp      : $BRIDGE_OPERATOR_PARTY"
echo "  User1         : $USER1_PARTY"
echo "  User1 fp      : $USER1_FP_BYTES32"
echo "  TokenConfig   : $TOKEN_CONFIG_ID"
echo "  BridgeState   : $BRIDGE_STATE_ID"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
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
