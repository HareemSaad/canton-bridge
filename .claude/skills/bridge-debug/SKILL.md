---
name: bridge-debug
description: Debug a failing canton-bridge relay. Use when a bridge transaction is stuck in PENDING or FAILED, the subgraph isn't indexing, or Canton commands are being rejected.
disable-model-invocation: true
---

# Bridge Debug

## Current State
- Relayer log (last 40 lines): !`tail -40 /tmp/relayer.log 2>/dev/null || echo "relayer not running"`
- DB status: !`docker exec relayer-postgres psql -U relayer -d relayer -t -c "SELECT nonce, status, LEFT(transaction_hash,20) as tx, LEFT(canton_tx_id,20) as ctid FROM bridge_transactions ORDER BY created_at DESC LIMIT 10;" 2>/dev/null || echo "DB not running"`
- Canton health: !`curl -s http://localhost:7575/v2/state/ledger-end 2>/dev/null || echo "Canton not running"`
- Subgraph health: !`curl -s http://localhost:8000/subgraphs/name/canton-bridge-local -H "Content-Type: application/json" -d '{"query":"{_meta{block{number}hasIndexingErrors}}"}' 2>/dev/null || echo "Subgraph not running"`
- Anvil health: !`cast block-number --rpc-url http://localhost:8545 2>/dev/null || echo "Anvil not running"`

---

ARGUMENTS: $ARGUMENTS

---

## Diagnose and Fix

Work through the following checklist in order. Stop at the first failing check and fix it.

### 1. Services Running?

Check that Anvil (8545), Canton JSON API (7575), graph-node (8020/8000), relayer-postgres (5433), and the NestJS relayer are all up. If any are down, restart from `./scripts/local-setup.sh`.

### 2. Subgraph Syncing?

If `_meta.block.number` is null or the subgraph reports "has not started syncing yet":
- Check `docker logs subgraph-graph-node-1 2>&1 | tail -20`
- Common cause: Gateway data source has `startBlock: 0`, forcing graph-node to scan from genesis which triggers Alchemy rate-limit on `eth_getLogs`
- **Fix:** Update `subgraph/subgraph.yaml` Gateway `startBlock` to match CantonBridge's, rebuild, redeploy:
  ```bash
  cd subgraph && npm run build
  npx graph deploy --node http://localhost:8020 --ipfs http://localhost:5001 --version-label "v0.0.x" canton-bridge-local
  ```
- If graph-node is in reorg loop from a stale previous run: `docker compose down -v && docker compose up -d` then recreate+deploy the subgraph.

### 3. Deposit Indexed by Subgraph?

```bash
curl -s http://localhost:8000/subgraphs/name/canton-bridge-local \
  -H "Content-Type: application/json" \
  -d '{"query":"{deposits(first:5,orderBy:nonce,orderDirection:desc){id nonce token fingerprint}}"}'
```

If empty but a deposit tx exists on-chain, the deposit block is before the subgraph's startBlock — redeploy with an earlier startBlock.

### 4. Deposit in Relayer DB?

```bash
docker exec relayer-postgres psql -U relayer -d relayer -c \
  "SELECT nonce, status, recipient, depositor FROM bridge_transactions ORDER BY created_at DESC LIMIT 5;"
```

- `<none>` → subgraph not returning deposits (step 3)
- `PENDING` → relayer hasn't processed pending-check cycle yet (waits 60s); or Canton relay is failing
- `FAILED` → check relayer log for the relay error (step 5)

### 5. Canton Relay Error?

```bash
grep -E "Failed to relay|Canton responded|FingerprintMapping|resolveFingerprint" /tmp/relayer.log | tail -10
```

Common errors and fixes:

| Error | Fix |
|---|---|
| `Failed to query active contracts: 400 ... activeAtOffset` | `resolveFingerprint` missing ledger-end fetch — check `canton.service.ts` |
| `expecting array at 'cumulative'` | cumulative must be `[{ templateFilters: [...] }]` not an object |
| `Missing required field at 'identifierFilter'` | Skip templateFilters entirely; filter by templateId in code |
| `No FingerprintMapping found for fingerprint: ...` | FingerprintMapping not created with correct hex; check Canton active contracts |
| `Canton responded 500` or `Already processed` | txHash already in BridgeState.processedTxHashes (replay guard) — this is correct behaviour |
| `CONTRACT_NOT_FOUND` for BridgeState ID | **BridgeState.RecordMint is consuming** — its contract ID changes after every successful relay. The relayer's `resolveForRelay()` fetches it fresh each call. If this error appears, the relayer is running stale compiled code — rebuild and restart. |
| `Cannot find managerId` | tokenConfigId wrong in relayer/.env — re-run local-setup.sh or look up live ID via active-contracts query |

### 6. Reset and Retry a FAILED Transaction

```bash
docker exec relayer-postgres psql -U relayer -d relayer -c \
  "UPDATE bridge_transactions SET status='PENDING' WHERE status='FAILED';"
```

The pending-check job runs every 60s and will retry automatically.

### 7. Verify FingerprintMappings on Canton

```bash
OPERATOR="<paste BridgeOperator party ID>"
OFFSET=$(curl -s http://localhost:7575/v2/state/ledger-end | python3 -c "import json,sys; print(json.load(sys.stdin)['offset'])")
curl -s -X POST http://localhost:7575/v2/state/active-contracts \
  -H "Content-Type: application/json" \
  -d "{\"activeAtOffset\":\"$OFFSET\",\"filter\":{\"filtersByParty\":{\"$OPERATOR\":{}}}}" \
  | python3 -c "
import json,sys
data=json.load(sys.stdin)
fps=[i for i in data if 'FingerprintMapping' in str(i)]
print(f'FingerprintMappings: {len(fps)}')
for c in fps:
    args=c['contractEntry']['JsActiveContract']['createdEvent']['createArgument']
    print(f'  fp={args[\"fingerprint\"]}  party={args[\"userParty\"][:60]}')
"
```

Expected: two entries with `fingerprint` matching `cast keccak "User1"` and `cast keccak "User2"` (without 0x).

### 8. Verify CIP56Holding After Successful Relay

```bash
# Same query as above, look for CIP56Holding entries
| python3 -c "
import json,sys
data=json.load(sys.stdin)
for i in data:
    c=i['contractEntry']['JsActiveContract']['createdEvent']
    if 'CIP56Holding' in c['templateId']:
        a=c['createArgument']
        print(f'CIP56Holding: owner={a[\"owner\"][:50]} amount={a[\"amount\"]} instrument={a[\"instrumentId\"]}')
"
```

### 9. Verify Replay Guard (BridgeState)

```bash
# Look for BridgeState in the active contracts output
# processedTxHashes should contain the relayed tx hash
```

If the same deposit is submitted twice, `RecordMint` will reject with "Already processed" — that's correct.

### 10. Fingerprint-based lookup returns empty results

If `GET /transactions?fingerprint=0x...` returns `{ deposits: [], withdrawals: [] }` but the DB clearly has a matching row:

- The DB stores fingerprint with `0x` prefix (The Graph `Bytes!` → `0x<hex>`).
- Check `transactions.service.ts:getByFingerprint` — it must normalize to `0x<hex>` not strip the prefix.
- Also confirm the relayer is running the latest build: `kill $(lsof -ti:3000) 2>/dev/null && cd relayer && yarn build && node dist/main.js > /tmp/relayer.log 2>&1 &`

### 11. BridgeState CONTRACT_NOT_FOUND on relays after the first

`BridgeState.RecordMint` is a **consuming** Daml choice — it archives and recreates the contract on every successful relay, so the contract ID changes constantly.

**Root cause:** Relayer running stale compiled code that cached `bridgeStateId` at startup.

**Fix:** Rebuild and restart. The current `resolveForRelay()` always fetches the live ID fresh — this bug cannot reappear unless the code is reverted.

```bash
cd relayer && yarn build
kill $(lsof -ti:3000) 2>/dev/null
node dist/main.js > /tmp/relayer.log 2>&1 &
# Then reset failed rows:
docker exec relayer-postgres psql -U relayer -d relayer \
  -c "UPDATE bridge_transactions SET status='PENDING' WHERE status='FAILED';"
```
