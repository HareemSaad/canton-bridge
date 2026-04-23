---
name: bridge-setup
description: Run the canton-bridge local stack from scratch. Use when setting up the local environment, resetting state, or troubleshooting the setup script.
disable-model-invocation: true
---

# Bridge Local Setup

## Current Environment
- Anvil: !`cast block-number --rpc-url http://localhost:8545 2>/dev/null && echo "RUNNING" || echo "STOPPED"`
- Canton: !`curl -sf http://localhost:7575/v2/state/ledger-end 2>/dev/null && echo "RUNNING" || echo "STOPPED"`
- Graph-node: !`nc -z localhost 8020 2>/dev/null && echo "RUNNING" || echo "STOPPED"`
- Relayer DB: !`nc -z localhost 5433 2>/dev/null && echo "RUNNING" || echo "STOPPED"`
- Relayer .env: !`[[ -f relayer/.env ]] && grep "LOCAL_TOKEN_CONFIG_ID" relayer/.env | head -1 || echo "MISSING"`

---

ARGUMENTS: $ARGUMENTS

---

## Full Setup (from scratch)

### Prerequisites
- `forge`, `cast`, `anvil` — Foundry nightly
- `daml` — SDK 3.4.11 (default)
- `docker` — for graph-node + relayer postgres
- `node` + `yarn` / `npm`
- `plasma/.env` with `PRIVATE_KEY` set

### Step 1 — Run local-setup.sh
```bash
# From project root — keeps Anvil + Canton alive until Ctrl-C
bash scripts/local-setup.sh 2>&1 | tee /tmp/setup.log
```

Wait for the summary block (`━━━━...━━━━`) before proceeding.

### Step 2 — Start the relayer (separate terminal)
```bash
cd relayer && yarn build && node dist/main.js 2>&1 | tee /tmp/relayer.log
```

Wait for: `Nest application successfully started`

### Step 3 — Start the frontend (separate terminal)
```bash
cd frontend && npm run dev
# opens http://localhost:5173
```

### Step 4 — Run e2e test (optional, separate terminal)
```bash
bash scripts/e2e-test.sh
bash scripts/e2e-canton-to-plasma-test.sh
```

Expected output: `E2E test passed — 1 mUSDC bridged from Plasma to Canton`

---

## Known Issues and Fixes

### Subgraph "has not started syncing yet" (graph-node rate-limited)

**Cause:** Gateway data source has `startBlock: 0`, causing graph-node to call
`eth_getLogs` from block 0 which Alchemy's free tier rate-limits to 10 blocks/call.

**Fix:** Both `CantonBridge` and `Gateway` data sources in `subgraph/subgraph.yaml`
must have `startBlock` matching the deployment block (~21066379). After editing:

```bash
cd subgraph
npm run build
npx graph deploy --node http://localhost:8020 --ipfs http://localhost:5001 \
  --version-label "v0.0.x" canton-bridge-local
```

### graph-node in reorg loop from previous run

**Symptom:** `ERRO Subgraph writer failed ... No rows affected`

**Fix:** Wipe graph-node volumes and redeploy:
```bash
cd subgraph
docker compose down -v
docker compose up -d
sleep 15
npx graph create --node http://localhost:8020 canton-bridge-local 2>/dev/null || true
npm run build
npx graph deploy --node http://localhost:8020 --ipfs http://localhost:5001 \
  --version-label "v0.0.1" canton-bridge-local
```

### `subgraph name not found: canton-bridge-local` on first deploy

**Cause:** `npm run create:local` creates `gateway-local` (hardcoded in package.json),
but we're deploying as `canton-bridge-local`.

**Fix:** Create manually before deploy:
```bash
npx graph create --node http://localhost:8020 canton-bridge-local
```
(Already fixed in `local-setup.sh` — use `npx graph create` directly.)

### FingerprintMapping not updated (placeholder fingerprints)

**Symptom:** Relayer logs `No FingerprintMapping found for fingerprint: 9267b5b6...`

**Check:**
```bash
OPERATOR=$(grep LOCAL_CANTON_PARTY_ID relayer/.env | cut -d= -f2)
OFFSET=$(curl -s http://localhost:7575/v2/state/ledger-end | python3 -c "import json,sys; print(json.load(sys.stdin)['offset'])")
curl -s -X POST http://localhost:7575/v2/state/active-contracts \
  -H "Content-Type: application/json" \
  -d "{\"activeAtOffset\":\"$OFFSET\",\"filter\":{\"filtersByParty\":{\"$OPERATOR\":{}}}}" \
  | python3 -c "
import json,sys
data=json.load(sys.stdin)
fps=[i for i in data if 'FingerprintMapping' in str(i)]
for c in fps:
    a=c['contractEntry']['JsActiveContract']['createdEvent']['createArgument']
    print(f'fp={a[\"fingerprint\"]}')
"
```

Expected fingerprints:
- User1: `$(cast keccak "User1" | tr -d '0x')`  (no 0x prefix)
- User2: `$(cast keccak "User2" | tr -d '0x')`

**Fix if wrong:** Re-run the FingerprintMapping update section from `local-setup.sh`,
or manually exercise Remove + CreateCommand via the Canton API.

### Canton relay fails with `400 cumulative expecting array`

Relayer's `resolveFingerprint` is sending wrong filter format.
In `relayer/src/canton/canton.service.ts`, ensure:
- `activeAtOffset` is fetched from `/v2/state/ledger-end` first
- No template filter is used in `filtersByParty` — filter by `templateId` in code instead

### Port already in use

```bash
lsof -ti:8545 | xargs kill -9 2>/dev/null   # kill Anvil
lsof -ti:6865 | xargs kill -9 2>/dev/null   # kill Canton gRPC
lsof -ti:7575 | xargs kill -9 2>/dev/null   # kill Canton JSON API
docker rm -f relayer-postgres 2>/dev/null
cd subgraph && docker compose down
```

---

## Quick Reset (keep Anvil/Canton running)

If you only need to reset the DB and retry:
```bash
docker exec relayer-postgres psql -U relayer -d relayer -c \
  "TRUNCATE bridge_transactions;"
```

Or reset only FAILED rows (relayer retries automatically within 60s):
```bash
docker exec relayer-postgres psql -U relayer -d relayer -c \
  "UPDATE bridge_transactions SET status='PENDING' WHERE status='FAILED';"
```

Note: `psql` is not on the host PATH — always use `docker exec relayer-postgres psql`.

---

## Contract Addresses (from last run)
- CantonBridge: check `plasma/broadcast/CantonBridge.s.sol/<CHAIN_ID>/run-latest.json`
- TokenConfig / BridgeState: check `relayer/.env` (BridgeState ID is only used for the startup log — `resolveForRelay()` always fetches it live)
- Party IDs: `daml ledger list-parties --host localhost --port 6865 --json`

## Known Bug: After Canton Restart, LOCAL_BRIDGE_STATE_ID in .env is Stale

`BridgeState.RecordMint` is consuming — the contract ID changes after every relay. After a Canton restart all IDs change. Update `.env` by querying the live ledger:

```bash
OPERATOR=$(grep LOCAL_CANTON_PARTY_ID relayer/.env | cut -d= -f2)
OFFSET=$(curl -s http://localhost:7575/v2/state/ledger-end | python3 -c "import json,sys; print(json.load(sys.stdin)['offset'])")
curl -s -X POST http://localhost:7575/v2/state/active-contracts \
  -H "Content-Type: application/json" \
  -d "{\"activeAtOffset\":\"$OFFSET\",\"filter\":{\"filtersByParty\":{\"$OPERATOR\":{}}}}" \
  | python3 -c "
import json,sys
data=json.load(sys.stdin)
for item in data:
    ev=item.get('contractEntry',{}).get('JsActiveContract',{}).get('createdEvent',{})
    tid=ev.get('templateId',''); cid=ev.get('contractId','')
    if 'TokenConfig' in tid: print(f'LOCAL_TOKEN_CONFIG_ID={cid}')
    if 'BridgeState' in tid: print(f'LOCAL_BRIDGE_STATE_ID={cid}')
"
```

Relay calls are unaffected (they always resolve the ID live) — the `.env` update is cosmetic for the startup log.
