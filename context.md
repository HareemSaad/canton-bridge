# Canton-Bridge Project Context

> Updated 2026-04-24 (session 4). Drop into a fresh Claude Code session and say "read context.md".

---

## What This Project Is

A **production-grade bidirectional token bridge**: EVM (Plasma testnet) ↔ Canton (Daml ledger).

- **Plasma → Canton**: User locks ERC-20 on EVM → relayer mints CIP-56 holding on Canton.
- **Canton → Plasma**: User burns CIP-56 holding on Canton → relayer unlocks ERC-20 on EVM.
- **Bridge model**: Lock/unlock on EVM (no EVM mint/burn by the bridge). Mint/burn on Canton — intentional, Canton uses a UTXO model; CIP56Holdings ARE the canonical representation of locked EVM tokens.
- **Receiver model**: Push-based on both sides. Recipient never touches the bridge contract.

The project went through two generations:
1. **POC** (Gateway.sol) — simple lock/unlock, still present for reference.
2. **Production** (CantonBridge.sol / CIP-56 Daml stack) — current active codebase.

---

## Repo Layout

```
canton-bridge/
├── plasma/                     # Solidity (Foundry project)
│   ├── src/
│   │   ├── CantonBridge.sol         # Main bridge contract (lock/unlock escrow)
│   │   ├── TokenRegistry.sol        # ERC-20 whitelist + CIP-56 ID mapping
│   │   ├── MockERC20.sol            # MockUSDC (6 dec), MockWBTC (8 dec)
│   │   ├── Gateway.sol              # POC — reference only
│   │   ├── interfaces/
│   │   │   ├── ICantonBridge.sol
│   │   │   └── IBridgeEvents.sol
│   │   └── security/
│   │       └── RateLimiter.sol
│   ├── script/
│   │   └── CantonBridge.s.sol
│   └── test/
│       └── CantonBridge.t.sol       # 30 Foundry tests (all passing)
│
├── canton/                     # Daml project (SDK 3.4.11)
│   ├── daml.yaml
│   └── daml/
│       ├── Main.daml                # Setup script
│       ├── CIP56/
│       │   ├── Token.daml           # CIP56Holding + CIP56Manager
│       │   ├── Config.daml          # TokenConfig (IssuerMint / IssuerBurn)
│       │   ├── Events.daml          # TokenTransferEvent (audit trail)
│       │   └── Compliance.daml      # ComplianceRules (optional KYC hook)
│       ├── Bridge/
│       │   ├── Contracts.daml       # MintCommand + DepositToPlasma + DepositToPlasmaEvent
│       │   └── State.daml           # BridgeState (replay protection)
│       └── Common/
│           ├── FingerprintAuth.daml # FingerprintMapping only (PendingDeposit/DepositReceipt removed)
│           ├── Types.daml
│           └── Utils.daml
│
├── subgraph/                   # The Graph indexer
│   ├── schema.graphql
│   ├── subgraph.yaml
│   └── src/
│       ├── cantonBridge.ts          # handleDeposit, handleTokenRegistered
│       └── gateway.ts               # Legacy
│
├── relayer/                    # NestJS off-chain relay service
│   └── src/
│       ├── config/configuration.ts  # Two-profile config: local / prod
│       ├── database/entities/
│       │   └── bridge-transaction.entity.ts
│       ├── subgraph/subgraph.service.ts
│       ├── watcher/watcher.service.ts        # Plasma→Canton poller
│       ├── withdrawal/
│       │   ├── withdrawal-watcher.service.ts # Canton→Plasma poller
│       │   └── withdrawal-watcher.module.ts
│       ├── canton/
│       │   ├── canton.service.ts             # resolveForRelay (fingerprint+BridgeState) + relay
│       │   ├── canton-query.service.ts       # Read-only Canton ledger queries
│       │   ├── canton.controller.ts          # GET /canton/balance, /canton/stats
│       │   └── dto/canton-command.dto.ts
│       ├── plasma/
│       │   ├── plasma.service.ts             # ethers ERC-20 reads + faucet (deployer wallet)
│       │   ├── plasma.controller.ts          # GET /plasma/balance, /plasma/token, POST /plasma/faucet
│       │   └── plasma.module.ts
│       └── transactions/
│           ├── transactions.service.ts       # DB + Canton ledger tx history
│           ├── transactions.controller.ts    # GET /transactions
│           └── transactions.module.ts
│
├── frontend/                   # React + Vite + ethers v6 SPA
│   ├── src/
│   │   ├── pages/
│   │   │   ├── PlasmaPage.tsx      # Wallet connect, faucet, bridge form, tx history
│   │   │   └── CantonPage.tsx      # Username connect/disconnect, holdings list, withdraw form, tx history
│   │   ├── components/TxTable.tsx  # Unified deposit+withdrawal table (typeLabels prop for perspective)
│   │   ├── hooks/useWallet.ts      # MetaMask connection (auto-adds chain 9746, auto-reconnect)
│   │   └── lib/
│   │       ├── api.ts              # Relayer API client
│   │       └── constants.ts        # Contract addresses, chain config
│   └── package.json
│
└── scripts/
    ├── local-setup.sh
    ├── e2e-test.sh                   # Plasma→Canton e2e
    ├── e2e-canton-to-plasma-test.sh  # Canton→Plasma e2e
    └── teardown.sh
```

---

## Key Architectural Concepts

### Fingerprint Model

EVM users pass a `bytes32 fingerprint = keccak256("User1")` to `depositToCanton()`.

- The relayer resolves fingerprint → Canton party ID via `FingerprintMapping` active contracts.
- At mint time the fingerprint is stored in `CIP56Holding.metadata["bridge.userFingerprint"]` (no 0x prefix).
- The Canton party hash suffix (the `1220<hash>` part after `::`) is **different** from the EVM fingerprint.
- `GET /canton/balance?fingerprint=<hex>` accepts **both**: EVM fingerprint OR Canton party hash suffix.

### CIP-56 Token Standard (Canton)

- `CIP56Holding` — UTXO-style balance. `signatory issuer` (bridge operator), `observer owner` (user). Owner controls Split/Merge/Transfer as `controller owner`. Issuer controls Burn.
- `CIP56Manager` — `Mint` (nonconsuming) and `BurnHolding` (nonconsuming) choices.
- `TokenConfig` — Wraps manager. `IssuerMint` creates holding + `TokenTransferEvent`. `IssuerBurn` destroys holding + event.

### MintCommand — Atomic Deposit Relay

```
MintCommand.Execute (single Canton transaction):
  1. BridgeState.RecordMint(txHash)   → replay guard (reverts on duplicate)
  2. TokenConfig.IssuerMint(...)      → CIP56Holding + TokenTransferEvent
```

### DepositToPlasma — User-Initiated Withdrawal

```
DepositToPlasma (signatory=user, observer=issuer):
  choice Accept (controller=issuer):
    → fetch holding, assert owner+amount match
    → TokenConfig.IssuerBurn(holdingId)
    → create DepositToPlasmaEvent { status=DepositPending }

DepositToPlasmaEvent (signatory=issuer, observer=user):
  choice Complete(evmTxHash) → status=DepositCompleted(evmTxHash)
  choice Fail(reason)        → status=DepositFailed(reason)
```

The withdrawal is user-initiated (user creates `DepositToPlasma`). The relayer accepts, burns, relays.

---

## Plasma → Canton Flow

```
1. User calls depositToCanton(token, amount, fingerprint)
   → tokens locked in CantonBridge escrow
   → emits DepositToCanton(token, user, amount, fingerprint, nonce)

2. Subgraph indexes → Deposit entity

3. WatcherService polls subgraph every 30s
   → inserts PENDING row in bridge_transactions

4. WatcherService pending-check every 60s
   → resolveFingerprint → party ID via FingerprintMapping
   → CreateAndExercise(MintCommand → Execute)
   → row updated to RELAYED

5. On Canton: CIP56Holding created with owner=recipient
   → holding appears on recipient's ledger (no claim needed)
```

---

## Canton → Plasma Flow

```
1. User creates DepositToPlasma contract (actAs=userParty, userId=sandbox)
   { user, issuer, holdingId, amount, evmRecipient, fingerprint }

2. WithdrawalWatcherService polls Canton active contracts every 30s
   Phase 1 — finds DepositToPlasma (not DepositToPlasmaEvent):
     → exercises Accept(tokenConfigId)
     → IssuerBurn destroys CIP56Holding
     → DepositToPlasmaEvent { status=DepositPending } created

   Phase 2 — finds DepositToPlasmaEvent with DepositPending:
     → fromCantonDecimal(amount) → rawAmount bigint
     → withdrawalId = ethers.id(contractId)   // keccak256 of Canton contract ID
     → sign proof: keccak256(token, rawAmount, evmRecipient, withdrawalId, chainId)
     → call withdrawFromCanton(token, rawAmount, evmRecipient, withdrawalId, proof) on EVM
     → tokens pushed directly to evmRecipient wallet (no claim needed)
     → exercise Complete(evmTxHash) on Canton

3. On failure: exercise Fail(reason) on Canton → status=DepositFailed
```

### Withdrawal proof signing

```typescript
const msgHash = ethers.solidityPackedKeccak256(
  ['address', 'uint256', 'address', 'bytes32', 'uint256'],
  [evmTokenAddress, rawAmount, evmRecipient, withdrawalId, chainId]
);
const proof = wallet.signMessage(ethers.getBytes(msgHash));  // adds \x19Ethereum Signed Message prefix
```

---

## Query API Endpoints

All require `Content-Type: application/json` is not needed (GET). EVM address params are validated with `ethers.isAddress`.

| Method | Route | Description |
|---|---|---|
| GET | `/plasma/balance?address=0x...&token=0x...` | ERC-20 balance. `token` defaults to configured MockUSDC |
| GET | `/plasma/token?token=0x...` | Token metadata + totalSupply + lockedInBridge |
| GET | `/canton/balance?party=<partyId>` | CIP56Holdings by full Canton party ID |
| GET | `/canton/balance?fingerprint=<hex>` | Holdings by EVM fingerprint OR Canton party hash suffix |
| GET | `/canton/stats` | Total Canton supply, holding count, withdrawal event counts |
| POST | `/canton/party/connect` | Create or connect a Canton party by username. Body: `{ username }`. Returns `{ partyId, fingerprint, created }`. Derives fingerprint as `keccak256(utf8(username))`. Allocates a new Canton party + `FingerprintMapping` if none exists. |
| POST | `/canton/withdraw` | Create `DepositToPlasma` on Canton (body: `fingerprint, holdingId, amount, evmRecipient`). Returns `{ updateId }`. Relayer picks it up within one poll cycle (~30s). |
| POST | `/plasma/faucet?address=0x...` | Mints 1,000 mUSDC to address using the deployer wallet (MockUSDC.mint) |
| GET | `/transactions?depositor=0x...` | Plasma→Canton deposits sent by this EVM address (from DB) |
| GET | `/transactions?fingerprint=<hex>` | Plasma→Canton deposits + Canton→Plasma withdrawals by this fingerprint |
| GET | `/transactions?evmRecipient=0x...` | Canton→Plasma withdrawals targeting this EVM address (from Canton ledger) |

Params on `/transactions` can be combined. Invalid EVM addresses return 400.

**Fingerprint format in DB:** stored with `0x` prefix (as returned by The Graph for `Bytes!` fields). The `getByFingerprint` normalizes the input to include `0x` before comparing — do NOT strip the prefix.

---

## Canton v2 HTTP API — Quirks

1. **`activeAtOffset` is required** — fetch from `GET /v2/state/ledger-end` first.
2. **No template filter** — query all contracts by party (`filtersByParty: { [partyId]: {} }`), filter by `templateId` in TypeScript.
3. **Response is a plain JSON array**: `[{ contractEntry: { JsActiveContract: { createdEvent: { contractId, templateId, createArgument } } } }]`
4. **`contractId` is inside `createdEvent`**, NOT directly on `JsActiveContract`.
5. `CIP56Holding.createArgument` fields: `issuer`, `owner`, `amount` (Decimal string), `instrumentId` (not `token`), `locked` (null or string), `metadata` (object).
6. `metadata["bridge.userFingerprint"]` holds the EVM fingerprint without 0x prefix.

---

## Relayer .env (auto-generated by local-setup.sh)

```env
MODE=local

LOCAL_DATABASE_URL=postgresql://relayer:relayer@localhost:5433/relayer
LOCAL_SUBGRAPH_URL=http://localhost:8000/subgraphs/name/canton-bridge-local
LOCAL_PLASMA_RPC=http://localhost:8545
LOCAL_RELAYER_PRIVATE_KEY=<deployer private key>
LOCAL_CANTON_BRIDGE_ADDRESS=<CantonBridge contract address>
LOCAL_EVM_TOKEN_ADDRESS=<MockUSDC contract address>
LOCAL_CHAIN_ID=9746
LOCAL_CANTON_URL=http://localhost:7575
LOCAL_CANTON_PARTY_ID=<BridgeOperator full party ID>
LOCAL_CANTON_TOKEN=
LOCAL_CANTON_USER_ID=sandbox
LOCAL_TOKEN_CONFIG_ID=<TokenConfig ContractId>
LOCAL_BRIDGE_STATE_ID=<BridgeState ContractId>

POLL_INTERVAL_MS=30000
PENDING_CHECK_INTERVAL_MS=60000
LOCAL_WITHDRAWAL_POLL_MS=30000
SUBGRAPH_PAGE_SIZE=100
CANTON_TOKEN_DECIMALS=6
PORT=3000
NODE_ENV=development
```

---

### Rebuild and restart relayer after code changes

```bash
cd relayer
yarn build
kill $(lsof -ti:3000) 2>/dev/null
node dist/main.js > /tmp/relayer.log 2>&1 &
```

The relayer **must be run from the `relayer/` directory** so that `.env` is found.

---

## DB Commands

Use `docker exec` — `psql` is not on the host PATH:

```bash
# Check recent transactions
docker exec relayer-postgres psql -U relayer -d relayer \
  -c "SELECT nonce, status, LEFT(transaction_hash,20) as tx, LEFT(recipient,20) as fp FROM bridge_transactions ORDER BY created_at DESC LIMIT 10;"

# Reset FAILED rows (relayer retries automatically on next 60s cycle)
docker exec relayer-postgres psql -U relayer -d relayer \
  -c "UPDATE bridge_transactions SET status='PENDING' WHERE status='FAILED';"

# Truncate
docker exec relayer-postgres psql -U relayer -d relayer \
  -c "TRUNCATE bridge_transactions;"
```

---

## Critical Architecture Notes

### BridgeState contract ID rotates on every relay

`BridgeState.RecordMint` is a **consuming** Daml choice — it archives the old contract and creates a new one with each processed deposit. The contract ID therefore changes after every successful relay.

**Never cache `LOCAL_BRIDGE_STATE_ID` from `.env` across relay calls.** The relayer's `resolveForRelay()` method fetches the live `BridgeState` ID from the active-contracts ledger on every relay call. This is intentional.

If `LOCAL_BRIDGE_STATE_ID` in `.env` is stale (e.g. after a Canton restart), it will only affect the startup log message — relay calls always resolve fresh.

### Fingerprint storage format

The subgraph returns `fingerprint` as `Bytes!` → The Graph serializes `Bytes` with `0x` prefix. So the DB `recipient` column stores `0x9267b5b6...`, not `9267b5b6...`. Any SQL comparison must include the `0x` prefix.

---

## Known Issues and Fixes

### Subgraph "has not started syncing yet"

**Cause**: Gateway `startBlock: 0` → scans from genesis → Alchemy rate-limited.
**Fix**: CantonBridge source is now set to address `0x59acb2967cc50c25b9d12b4b329e4da94054a897` startBlock `21199443`. Gateway source still has a placeholder address but its startBlock is now `21199443`. `local-setup.sh` also handles this automatically.

### graph-node reorg loop from previous run

**Symptom**: `ERRO Subgraph writer failed ... No rows affected`
```bash
cd subgraph && docker compose down -v && docker compose up -d
sleep 15
npx graph create --node http://localhost:8020 canton-bridge-local 2>/dev/null || true
npm run build
npx graph deploy --node http://localhost:8020 --ipfs http://localhost:5001 --version-label "v0.0.1" canton-bridge-local
```

### `No FingerprintMapping found`

```bash
OPERATOR=$(grep LOCAL_CANTON_PARTY_ID relayer/.env | cut -d= -f2)
OFFSET=$(curl -s http://localhost:7575/v2/state/ledger-end | python3 -c "import json,sys; print(json.load(sys.stdin)['offset'])")
curl -s -X POST http://localhost:7575/v2/state/active-contracts \
  -H "Content-Type: application/json" \
  -d "{\"activeAtOffset\":\"$OFFSET\",\"filter\":{\"filtersByParty\":{\"$OPERATOR\":{}}}}" \
  | python3 -c "
import json,sys; data=json.load(sys.stdin)
fps=[i for i in data if 'FingerprintMapping' in str(i)]
print(f'{len(fps)} FingerprintMappings')
for c in fps:
    a=c['contractEntry']['JsActiveContract']['createdEvent']['createArgument']
    print(f'  fp={a[\"fingerprint\"]}  party={a[\"userParty\"][:60]}')
"
```

### Port conflicts

```bash
lsof -ti:8545 | xargs kill -9 2>/dev/null
lsof -ti:6865 | xargs kill -9 2>/dev/null
lsof -ti:7575 | xargs kill -9 2>/dev/null
lsof -ti:3000  | xargs kill -9 2>/dev/null
docker rm -f relayer-postgres 2>/dev/null
cd subgraph && docker compose down
```

---

## Solidity Key Facts

```
depositToCanton(token, amount, fingerprint)
  safeTransferFrom → _lockedBalances[token] += amount
  emits DepositToCanton(token, user, amount, fingerprint, nonce)

withdrawFromCanton(token, amount, recipient, withdrawalId, proof)
  _verifyRelayerProof: signer must have RELAYER_ROLE
  proof = sign(keccak256(token, amount, recipient, withdrawalId, chainid))
  executedWithdrawals[withdrawalId] = true   (replay guard)
  safeTransfer(recipient, amount)            (direct push — no claim needed)
  if amount > timeLockThreshold: queue in timeLocked instead
    → anyone (including relayer) can call executeTimeLocked after delay
```

### Withdrawal proof (relayer TypeScript)

```typescript
const msgHash = ethers.solidityPackedKeccak256(
  ['address', 'uint256', 'address', 'bytes32', 'uint256'],
  [token, rawAmount, recipient, withdrawalId, chainId]
);
const proof = wallet.signMessage(ethers.getBytes(msgHash));
```

### Withdrawal proof (Foundry test)

```solidity
bytes32 RELAYER_ROLE = bridge.RELAYER_ROLE();  // cache BEFORE expectRevert
bytes32 msgHash = keccak256(abi.encodePacked(token, amount, recipient, withdrawalId, block.chainid));
bytes32 ethHash = MessageHashUtils.toEthSignedMessageHash(msgHash);
(uint8 v, bytes32 r, bytes32 s) = vm.sign(relayerKey, ethHash);
bytes memory proof = abi.encodePacked(r, s, v);
```

---

## Daml Templates

| Module | Templates |
|---|---|
| `CIP56.Token` | `CIP56Holding`, `CIP56Manager` |
| `CIP56.Config` | `TokenConfig` (IssuerMint, IssuerBurn) |
| `CIP56.Events` | `TokenTransferEvent` |
| `Bridge.State` | `BridgeState` |
| `Bridge.Contracts` | `MintCommand`, `DepositToPlasma`, `DepositToPlasmaEvent` |
| `Common.FingerprintAuth` | `FingerprintMapping` only |

**Removed / deleted**:
- `BridgeReceiver.daml`, `MockUSDCx.daml` — legacy POC, deleted
- `PendingDeposit`, `DepositReceipt` — unused, removed from FingerprintAuth

### Daml decimal conversion

```typescript
// toCantonDecimal("1000000", 6) → "1.000000"
const raw = BigInt(rawAmount);
const divisor = BigInt(10 ** decimals);
return `${raw / divisor}.${(raw % divisor).toString().padStart(decimals, '0')}`;

// fromCantonDecimal("1.000000", 6) → 1000000n
const [whole, frac = ''] = s.split('.');
return BigInt(whole) * BigInt(10 ** decimals) + BigInt(frac.padEnd(decimals, '0').slice(0, decimals));
```

---

## Git History

```
db3ca4a feat: username-based Canton wallet connect — allocate party + FingerprintMapping on demand
d6c8258 docs: update context.md and daml-bridge skill for session 3
644cf2c feat(frontend): canton -> plasma user flow
4d234a4 docs: update context.md and skills for session 2 changes
e5b4500 fix(relayer): resolve BridgeState ID fresh on every relay; fix fingerprint DB lookup
8136e5a feat: add bridge frontend and faucet API
ae197f5 docs: update context.md to reflect bidirectional bridge implementation
55acf9d fix(relayer): support Canton party hash lookup in getHoldingsByFingerprint
4011cb3 feat(relayer): add Canton→Plasma withdrawal watcher and query controllers
```

---

## Local Setup Sequence (with Frontend)

**Terminal 1:**
```bash
bash scripts/local-setup.sh
# Wait for the ━━━━━ summary block
```

**Terminal 2 (relayer) — run from relayer/ directory:**
```bash
cd relayer && yarn build && node dist/main.js
```

**Terminal 3 (frontend):**
```bash
cd frontend && npm run dev
# opens http://localhost:5173
```

**Terminal 4 — e2e tests (optional):**
```bash
bash scripts/e2e-test.sh
bash scripts/e2e-canton-to-plasma-test.sh
```

---

## What Is NOT Yet Done

1. **Production deployment**: All config values are local. The `prod` profile in `configuration.ts` is wired but `PROD_*` env vars are empty.

2. **Multi-token support**: `TokenConfig` is hardcoded to `MockUSDC::canton`. Multiple tokens would need either multiple `TokenConfig` contracts or a lookup by instrument ID.

3. **BridgeState scaling**: `processedTxHashes` is an ever-growing list in a single Daml contract. Needs sharding at high volume.

4. **Subgraph Alchemy RPC**: `FORK_RPC` in `local-setup.sh` is hardcoded. Should be moved to an env var.

5. **Partial holding withdrawal**: Canton→Plasma withdrawals consume the full holding. Splitting a holding (CIP56Holding.Split choice) before `DepositToPlasma` is not surfaced in the frontend.

---

## User Preferences (for Claude)

- No "Co-Authored-By: Claude" in git commits.
- Terse responses — skip summaries of what was just done.
- No docstrings/comments on unchanged code.
- No extra error handling, abstractions, or future-proofing beyond what was asked.
