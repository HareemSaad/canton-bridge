# Canton-Bridge Project Context

> Written 2026-04-23 for use in a fresh Claude Code session.
> Drop this file into the conversation at the start and say "read context.md".

---

## What This Project Is

A **production-grade one-way token bridge**: EVM (Plasma testnet) → Canton (Daml ledger).

- **Direction implemented**: Plasma → Canton (deposit EVM tokens, receive CIP-56 holdings on Canton).
- **Return direction** (Canton → EVM withdrawal): contracts exist (`withdrawFromCanton` + `WithdrawalRequest`/`WithdrawalEvent` Daml templates) but the relayer does not yet watch for Canton-side withdrawals.
- **Reference**: ChainSafe `canton-erc20` CIP-56 standard was the design template.

The project went through two generations:
1. **POC** (Gateway.sol / BridgeReceiver.daml) — a simple lock/unlock bridge. Still present in the repo for reference.
2. **Production** (CantonBridge.sol / CIP-56 Daml stack) — the current active codebase, built in the sessions documented here.

---

## Repo Layout

```
canton-bridge/
├── plasma/                     # Solidity (Foundry project)
│   ├── src/
│   │   ├── CantonBridge.sol         # Main bridge contract (ACTIVE)
│   │   ├── TokenRegistry.sol        # ERC-20 whitelist + CIP-56 ID mapping
│   │   ├── MockERC20.sol            # MockUSDC (6 dec), MockWBTC (8 dec)
│   │   ├── Gateway.sol              # POC — kept for reference only
│   │   ├── interfaces/
│   │   │   ├── ICantonBridge.sol    # Errors + function signatures
│   │   │   └── IBridgeEvents.sol    # All bridge events
│   │   └── security/
│   │       └── RateLimiter.sol      # Abstract per-token rate limiter
│   ├── script/
│   │   ├── CantonBridge.s.sol       # Deploy: TokenRegistry + CantonBridge + MockUSDC
│   │   └── Gateway.s.sol            # POC deploy (reference only)
│   └── test/
│       ├── CantonBridge.t.sol       # 30 Foundry tests (all passing)
│       └── Gateway.t.sol            # POC tests
│
├── canton/                     # Daml project (SDK 3.4.11)
│   ├── daml.yaml                    # name=canton-bridge, version=1.0.0, init-script=Main:setup
│   └── daml/
│       ├── Main.daml                # Setup script: allocates parties, creates contracts, prints IDs
│       ├── CIP56/
│       │   ├── Token.daml           # CIP56Holding + CIP56Manager templates
│       │   ├── Config.daml          # TokenConfig (IssuerMint / IssuerBurn)
│       │   ├── Events.daml          # TokenTransferEvent (immutable audit trail)
│       │   └── Compliance.daml      # ComplianceRules (optional KYC hook)
│       ├── Bridge/
│       │   ├── Contracts.daml       # MintCommand, WithdrawalRequest, WithdrawalEvent
│       │   └── State.daml           # BridgeState (replay protection via processedTxHashes)
│       ├── Common/
│       │   ├── FingerprintAuth.daml # FingerprintMapping, PendingDeposit, DepositReceipt
│       │   ├── Types.daml           # EvmAddress, ChainRef, BridgeDirection, TokenMeta
│       │   └── Utils.daml           # isValidAmount, isValidEvmAddress, etc.
│       ├── BridgeReceiver.daml      # POC — kept for reference
│       └── MockUSDCx.daml           # POC — kept for reference
│
├── subgraph/                   # The Graph indexer (AssemblyScript)
│   ├── schema.graphql               # Deposit, TokenRegistration, Lock (legacy)
│   ├── subgraph.yaml                # Two data sources: CantonBridge + Gateway (legacy)
│   └── src/
│       ├── cantonBridge.ts          # handleDeposit, handleTokenRegistered, handleTokenDeregistered
│       └── gateway.ts               # Legacy lock handler
│
├── relayer/                    # NestJS off-chain relay service
│   └── src/
│       ├── config/configuration.ts  # Two-profile config: local / prod
│       ├── database/entities/
│       │   └── bridge-transaction.entity.ts  # BridgeTransaction TypeORM entity
│       ├── subgraph/
│       │   └── subgraph.service.ts  # fetchDepositsSinceNonce() GraphQL query
│       ├── watcher/
│       │   └── watcher.service.ts   # Poll subgraph → insert DB → checkPending → relay
│       └── canton/
│           ├── canton.service.ts    # resolveFingerprint() + relay() via Canton v2 API
│           └── dto/canton-command.dto.ts  # CantonSubmitRequest / CantonSubmitResponse
│
└── scripts/
    ├── local-setup.sh               # Full local stack bootstrap (see details below)
    ├── e2e-test.sh                  # End-to-end test: deposit → DB RELAYED → CIP56Holding
    ├── canton-txns.sh               # Show all Canton ledger transactions
    └── teardown.sh                  # Kill Anvil, Canton, Docker containers
```

---

## Key Architectural Concepts

### Fingerprint Model

EVM users do **not** pass their full Canton party ID string. They pass a `bytes32 fingerprint`:

```
fingerprint = keccak256("User1")   // the party hint string
```

- The bridge operator maintains `FingerprintMapping` contracts on Canton (one per registered user).
- Each mapping links `fingerprint (hex, no 0x)` → `userParty (full Canton party ID)`.
- The relayer resolves the fingerprint to a party before minting.
- This is more gas-efficient and private than passing the full party ID.

**Important**: In local testing, fingerprints are computed as `cast keccak "User1"` (and `"User2"`). The 0x-prefixed value is passed to `depositToCanton()` on EVM. The no-0x hex is stored in the `FingerprintMapping` Daml contract.

### CIP-56 Token Standard (Canton)

- `CIP56Holding` — UTXO-style on-ledger balance. Each holding is a separate contract. Owner controls Split/Merge/Transfer. Issuer controls Burn.
- `CIP56Manager` — Controls token supply. Has `Mint` (nonconsuming) and `BurnHolding` choices.
- `TokenConfig` — Wraps `CIP56Manager`. The relayer calls `IssuerMint` which: (1) calls `CIP56Manager.Mint`, (2) creates a `TokenTransferEvent` for audit trail.

### MintCommand — Atomic Relay

The relayer never calls `IssuerMint` directly. It uses `CreateAndExercise(MintCommand → Execute)`:

```
MintCommand.Execute atomically:
  1. exercises BridgeState.RecordMint(txHash) → replay guard (reverts if duplicate)
  2. exercises TokenConfig.IssuerMint(recipient, amount, ...) → creates CIP56Holding + audit event
```

This is a single Canton ledger transaction. If either step fails, both roll back.

### BridgeState — Replay Protection

`BridgeState.processedTxHashes` is a list of all EVM tx hashes that have been minted. `RecordMint` asserts the hash is not already in the list. The list grows with every deposit. (Not sharded — fine for local/testnet scale; would need redesign for production at scale.)

### FingerprintMapping Creation — No Placeholder Round-Trip

`Main.daml` does NOT create `FingerprintMapping` contracts. It would need to know the fingerprints at creation time, but the keccak256 values must be computed externally. Instead:

- `Main.daml` creates: `CIP56Manager`, `TokenConfig`, `BridgeState`, allocates parties.
- `local-setup.sh` creates `FingerprintMapping` contracts directly via the Canton HTTP API after computing `cast keccak "User1"` and `"User2"`.

This avoids a Remove+Create round-trip (which would have been 10 ledger txns instead of 6).

---

## Deposit Flow (Plasma → Canton)

```
1. User approves CantonBridge to spend ERC-20 tokens
2. User calls depositToCanton(token, amount, bytes32(keccak256("User1")))
   → CantonBridge validates token, amount, fingerprint
   → checks rate limit (per-token, per-window)
   → pulls tokens via safeTransferFrom
   → increments user nonce
   → emits DepositToCanton(token, user, amount, fingerprint, nonce)

3. Subgraph indexes DepositToCanton → creates Deposit entity

4. Relayer WatcherService polls subgraph every 30s:
   → fetchDepositsSinceNonce(lastNonce, pageSize)
   → inserts new rows into bridge_transactions table (status=PENDING)

5. Relayer WatcherService pending-check job runs every 60s:
   → finds PENDING rows
   → calls canton.relay(tx):
       a. resolveFingerprint(tx.recipient)  → fetches all active contracts, finds FingerprintMapping, returns userParty
       b. submits CreateAndExercise(MintCommand → Execute) to /v2/commands/submit-and-wait
   → updates row to RELAYED (or FAILED)

6. On Canton: MintCommand.Execute
   → BridgeState.RecordMint(txHash) → adds to processedTxHashes
   → TokenConfig.IssuerMint → CIP56Manager.Mint → new CIP56Holding contract
   → TokenTransferEvent created (audit trail)
```

---

## Canton v2 HTTP API — Quirks and Gotchas

These were discovered through trial and error. **Do not deviate from these patterns.**

### `/v2/state/active-contracts`

1. **`activeAtOffset` is REQUIRED.** Fetch it first from `/v2/state/ledger-end`:
   ```
   GET /v2/state/ledger-end → { offset: "..." }
   ```

2. **Template filtering is broken** (for our use case). Using `cumulative.templateFilters` requires an `identifierFilter` field inside each filter entry — undocumented and finicky. **Workaround**: query all contracts by party with no template filter, then filter by `templateId` in TypeScript code:
   ```typescript
   filter: { filtersByParty: { [this.partyId]: {} } }
   // then: items.find(item => item.contractEntry?.JsActiveContract?.createdEvent?.templateId?.includes('FingerprintMapping'))
   ```

3. **Response is a plain JSON array**, NOT `{ activeContracts: [...] }`:
   ```
   [ { contractEntry: { JsActiveContract: { createdEvent: { templateId, createArgument } } } } ]
   ```

4. If you must use `cumulative`, it must be an **array**, not an object:
   ```json
   { "cumulative": [{ "templateFilters": [...] }] }  // CORRECT
   { "cumulative": { "templateFilters": [...] } }      // WRONG — "expecting array"
   ```

### `/v2/commands/submit-and-wait`

- `CreateAndExercise` command structure:
  ```json
  {
    "CreateAndExerciseCommand": {
      "templateId": "#canton-bridge:Bridge.Contracts:MintCommand",
      "createArguments": { ... },
      "choice": "Execute",
      "choiceArgument": { "dummy": {} }
    }
  }
  ```
- Template ID format: `#<dar-name>:<Module>.<Template>`
- Decimal amounts: Daml `Decimal` is a string like `"1.000000"` (NOT a JS number).

---

## Subgraph

- **Name**: `canton-bridge-local`
- **Two data sources**: `CantonBridge` (active) + `Gateway` (legacy, kept for historical indexing).
- **Critical**: Both data sources must have `startBlock` matching the CantonBridge deployment block (not 0). If Gateway has `startBlock: 0`, graph-node will try to scan from genesis, which triggers Alchemy eth_getLogs rate-limits on the forked RPC.
- `local-setup.sh` patches `subgraph.yaml` automatically after deployment.
- The GraphQL `Deposit` entity has field `fingerprint` (Bytes) — this is what the relayer queries.

### Key GraphQL query (relayer)

```graphql
query FetchDeposits($afterNonce: BigInt!, $first: Int!) {
  deposits(where: { nonce_gt: $afterNonce }, orderBy: nonce, orderDirection: asc, first: $first) {
    id nonce token amount fingerprint user blockNumber blockTimestamp transactionHash
  }
}
```

---

## Relayer Database

PostgreSQL (Docker container `relayer-postgres`, port 5433).

Table: `bridge_transactions`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `nonce` | bigint UNIQUE | From the DepositToCanton event |
| `token` | varchar(42) | ERC-20 address |
| `amount` | numeric(78,0) | Raw token units |
| `recipient` | text | **bytes32 fingerprint hex** (for CantonBridge) or Canton party ID (legacy Gateway) |
| `depositor` | varchar(42) | EVM depositor address |
| `to_chain` | varchar(66) | NULL for CantonBridge; keccak256 chain ID for legacy Gateway |
| `transaction_hash` | varchar(66) | EVM tx hash |
| `status` | enum | PENDING → RELAYED or FAILED |
| `canton_tx_id` | text | Canton updateId on success |
| `canton_submitted_at` | timestamptz | |

### Useful DB commands

```bash
# Check recent transactions
docker exec relayer-postgres psql -U relayer -d relayer -c \
  "SELECT nonce, status, LEFT(transaction_hash,20) as tx, LEFT(recipient,20) as fp FROM bridge_transactions ORDER BY created_at DESC LIMIT 10;"

# Reset FAILED rows for retry
docker exec relayer-postgres psql -U relayer -d relayer -c \
  "UPDATE bridge_transactions SET status='PENDING' WHERE status='FAILED';"

# Truncate everything (full reset)
docker exec relayer-postgres psql -U relayer -d relayer -c \
  "TRUNCATE bridge_transactions;"
```

---

## Relayer .env (auto-generated by local-setup.sh)

```env
MODE=local

LOCAL_DATABASE_URL=postgresql://relayer:relayer@localhost:5433/relayer
LOCAL_SUBGRAPH_URL=http://localhost:8000/subgraphs/name/canton-bridge-local
LOCAL_PLASMA_RPC=http://localhost:8545
LOCAL_CANTON_URL=http://localhost:7575
LOCAL_CANTON_PARTY_ID=<BridgeOperator full party ID>
LOCAL_CANTON_TOKEN=
LOCAL_CANTON_USER_ID=sandbox
LOCAL_TOKEN_CONFIG_ID=<TokenConfig ContractId from Canton>
LOCAL_BRIDGE_STATE_ID=<BridgeState ContractId from Canton>

POLL_INTERVAL_MS=30000
PENDING_CHECK_INTERVAL_MS=60000
SUBGRAPH_PAGE_SIZE=100
CANTON_TOKEN_DECIMALS=6
PORT=3000
NODE_ENV=development
```

---

## Local Setup Sequence

### Prerequisites

- `forge`, `cast`, `anvil` (Foundry nightly)
- `daml` SDK 3.4.11
- `docker`
- `node` + `yarn`
- `plasma/.env` with `PRIVATE_KEY` set

### Full stack from scratch

**Terminal 1 — keeps running:**
```bash
bash scripts/local-setup.sh 2>&1 | tee /tmp/setup.log
# Wait for the ━━━━━ summary block before continuing
```

**Terminal 2 — relayer:**
```bash
cd relayer && yarn install && yarn start:dev 2>&1 | tee /tmp/relayer.log
# Wait for: "Nest application successfully started"
```

**Terminal 3 — e2e test:**
```bash
bash scripts/e2e-test.sh
# Expected: "E2E test passed — 1 mUSDC bridged from Plasma to Canton"
```

### What local-setup.sh does (step by step)

1. Kill any existing Anvil on port 8545, start fresh Anvil fork of Plasma testnet
2. Fund deployer wallet with 100 ETH via `anvil_setBalance`
3. Deploy via `forge script CantonBridge.s.sol:DeployCantonBridge`:
   - TokenRegistry
   - CantonBridge (with deployer as admin + relayer)
   - MockUSDC (mints 1000 mUSDC to deployer)
   - Registers MockUSDC with CIP-56 ID `"MockUSDC::canton"`
4. Parse deployment block number and contract addresses from broadcast JSON
5. Patch `subgraph/subgraph.yaml` — set CantonBridge address, startBlock for both data sources
6. Start graph-node Docker stack (`docker compose up -d` in `subgraph/`)
7. Start relayer PostgreSQL Docker container on port 5433
8. Build Daml DAR (`daml build`)
9. Start Canton sandbox (gRPC :6865, JSON API :7575)
10. Run `daml script --script-name Main:setup` — allocates BridgeOperator/User1/User2 parties, creates CIP56Manager + TokenConfig + BridgeState
11. Parse TOKEN_CONFIG_ID and BRIDGE_STATE_ID from script stdout
12. Fetch party IDs via `daml ledger list-parties`
13. Compute fingerprints: `USER1_FP=$(cast keccak "User1")`, `USER2_FP=$(cast keccak "User2")`
14. Create FingerprintMapping contracts via Canton HTTP API (no-0x fingerprint stored in Daml)
15. Write complete `relayer/.env`
16. Build subgraph: `npm install`, `npm run codegen`, `npm run build`
17. Deploy subgraph: `npx graph create` + `npx graph deploy`
18. Print summary block with all contract addresses + party IDs

---

## Known Issues and Fixes

### Subgraph "has not started syncing yet" (rate-limited)

**Cause**: Gateway `startBlock: 0` → graph-node scans from genesis → Alchemy `eth_getLogs` rate-limited on free tier.
**Fix**: Set both data source `startBlock` values to the CantonBridge deployment block. `local-setup.sh` does this automatically. Manual fix:
```bash
cd subgraph && npm run build
npx graph deploy --node http://localhost:8020 --ipfs http://localhost:5001 --version-label "v0.0.x" canton-bridge-local
```

### graph-node reorg loop from previous run

**Symptom**: `ERRO Subgraph writer failed ... No rows affected`
**Fix**: Wipe graph-node volumes and redeploy:
```bash
cd subgraph
docker compose down -v
docker compose up -d
sleep 15
npx graph create --node http://localhost:8020 canton-bridge-local 2>/dev/null || true
npm run build
npx graph deploy --node http://localhost:8020 --ipfs http://localhost:5001 --version-label "v0.0.1" canton-bridge-local
```

### Subgraph name mismatch

`npm run create:local` in package.json creates `gateway-local`, but we deploy as `canton-bridge-local`. Always use `npx graph create --node http://localhost:8020 canton-bridge-local` directly.

### `No FingerprintMapping found for fingerprint: ...`

FingerprintMapping was not created, or was created with wrong fingerprint format.

Check what's on the ledger:
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
print(f'FingerprintMappings found: {len(fps)}')
for c in fps:
    a=c['contractEntry']['JsActiveContract']['createdEvent']['createArgument']
    print(f'  fp={a[\"fingerprint\"]}  party={a[\"userParty\"][:60]}')
"
```

Expected fingerprints (no 0x prefix):
- User1: `cast keccak "User1" | sed 's/0x//'`
- User2: `cast keccak "User2" | sed 's/0x//'`

### Canton relay fails with `400 cumulative expecting array`

`resolveFingerprint` is sending wrong filter format. See the API quirks section above. Current `canton.service.ts` correctly avoids this by not using template filters at all.

### `Already processed` / `Bridge replay detected`

The same EVM tx hash was submitted twice to Canton. `BridgeState.RecordMint` correctly rejected it. This is expected behavior — the relayer DB row should already be RELAYED.

### Port conflicts

```bash
lsof -ti:8545 | xargs kill -9 2>/dev/null   # Anvil
lsof -ti:6865 | xargs kill -9 2>/dev/null   # Canton gRPC
lsof -ti:7575 | xargs kill -9 2>/dev/null   # Canton JSON API
docker rm -f relayer-postgres 2>/dev/null
cd subgraph && docker compose down
```

---

## Solidity Contracts — Key Facts

### CantonBridge.sol

```
Roles:
  DEFAULT_ADMIN_ROLE  — deployer, grants other roles, emergencyWithdraw
  RELAYER_ROLE        — signs withdrawal proofs
  PAUSER_ROLE         — pause/unpause

depositToCanton(address token, uint256 amount, bytes32 fingerprint)
  - onlyRegisteredToken, nonReentrant, whenNotPaused
  - _checkAndUpdateRateLimit
  - safeTransferFrom → _lockedBalances[token] += amount
  - emits DepositToCanton(token, user, amount, fingerprint, nonce)

withdrawFromCanton(address token, uint256 amount, address recipient, bytes32 withdrawalId, bytes proof)
  - _verifyRelayerProof → ECDSA over keccak256(token, amount, recipient, withdrawalId, chainid)
  - executedWithdrawals[withdrawalId] = true  (replay guard)
  - if amount > timeLockThreshold[token]: queue timeLocked entry
  - else: safeTransfer to recipient

emergencyWithdraw(address token, address to)
  - onlyRole(DEFAULT_ADMIN_ROLE), whenPaused
```

### TokenRegistry.sol

- `registerToken(address, string cip56Id)` — auto-fetches ERC20Metadata
- `registerTokenWithMetadata(address, symbol, name, decimals, cip56Id)` — manual
- `isRegistered(address) → bool`
- `getCip56Id(address) → string`
- `getActiveTokens() → address[]`

### RateLimiter.sol (abstract, inherited by CantonBridge)

- `_setRateLimit(token, maxAmount, period)` — maxAmount=0 disables
- `_checkAndUpdateRateLimit(token, amount)` — auto-resets on period expiry, reverts `TokenRateLimitExceeded`
- `getRateLimit(token)`, `getRemainingRateLimit(token)`

### Withdrawal proof signing (for tests / Canton → EVM direction)

```solidity
bytes32 msgHash = keccak256(abi.encodePacked(token, amount, recipient, withdrawalId, block.chainid));
bytes32 ethHash = MessageHashUtils.toEthSignedMessageHash(msgHash);
(uint8 v, bytes32 r, bytes32 s) = vm.sign(relayerKey, ethHash);
bytes memory proof = abi.encodePacked(r, s, v);
```

### IMPORTANT test pattern — pre-cache role bytes32 before vm.expectRevert

```solidity
// WRONG — bridge.RELAYER_ROLE() staticcall CONSUMES expectRevert
vm.expectRevert(...);
bridge.grantRole(bridge.RELAYER_ROLE(), addr);  // fails silently

// CORRECT
bytes32 RELAYER_ROLE = bridge.RELAYER_ROLE();  // cache first
vm.expectRevert(...);
bridge.grantRole(RELAYER_ROLE, addr);
```

---

## Daml Templates — Key Facts

### Module structure

| Module | Key templates |
|---|---|
| `CIP56.Token` | `CIP56Holding`, `CIP56Manager` |
| `CIP56.Config` | `TokenConfig` |
| `CIP56.Events` | `TokenTransferEvent` |
| `Bridge.State` | `BridgeState` |
| `Bridge.Contracts` | `MintCommand`, `WithdrawalRequest`, `WithdrawalEvent` |
| `Common.FingerprintAuth` | `FingerprintMapping`, `PendingDeposit`, `DepositReceipt` |
| `Common.Types` | `EvmAddress`, `ChainRef`, `BridgeDirection`, `TokenMeta` |

### Main.daml setup script

Creates (in order):
1. `CIP56Manager` — issuer=BridgeOperator
2. `TokenConfig` — instrumentId="MockUSDC::canton", managerId=above, auditObservers=[]
3. `BridgeState` — bridgeOperator=BridgeOperator, processedTxHashes=[]

Prints to stdout (parsed by `local-setup.sh`):
```
BRIDGE_OPERATOR=BridgeOperator::...
USER1_PARTY=User1::...
USER2_PARTY=User2::...
TOKEN_CONFIG_ID=<hex ContractId>
BRIDGE_STATE_ID=<hex ContractId>
```

Does NOT create FingerprintMappings — those are created by `local-setup.sh` directly.

### Daml decimal conversion

EVM `uint256` raw amount → Daml `Decimal` string:
```typescript
// toCantonDecimal("1000000", 6) → "1.000000"
const raw = BigInt(rawAmount);
const divisor = BigInt(10 ** decimals);
const whole = raw / divisor;
const rem = raw % divisor;
return `${whole}.${rem.toString().padStart(decimals, '0')}`;
```

---

## Foundry Commands

```bash
cd plasma

# Run all tests
forge test -vv

# Run a specific test
forge test --match-test test_Deposit_TransfersTokensToBridge -vvv

# Fuzz test
forge test --match-test testFuzz_Deposit_AnyAmount --fuzz-runs 1000

# Deploy locally (Anvil must be running)
PRIVATE_KEY=0x... RELAYER_ADDRESS=0x... CIP56_INSTRUMENT="MockUSDC::canton" \
forge script script/CantonBridge.s.sol:DeployCantonBridge \
  --rpc-url http://localhost:8545 --broadcast
```

---

## Daml Commands

```bash
cd canton

# Build DAR
daml build

# Run tests
daml test

# Run script against live sandbox
daml script \
  --dar .daml/dist/canton-bridge-1.0.0.dar \
  --script-name "Main:setup" \
  --ledger-host localhost --ledger-port 6865 \
  --wall-clock-time

# List parties
daml ledger list-parties --host localhost --port 6865 --json
```

---

## Git History (production implementation)

```
ed4ed1a docs(skills): add Canton/Daml bridge skills for Claude Code
6c54a84 feat(scripts): rewrite local-setup.sh and e2e-test.sh for CantonBridge
090ebe6 feat(relayer): fingerprint-based MintCommand relay flow
ac2ff7f feat(subgraph): index CantonBridge events alongside legacy Gateway
8f9035d feat(canton): update Main.daml setup script and daml.yaml
7ccd889 feat(canton): CIP-56 Daml templates for production bridge
b1dcf57 test(plasma): full Foundry test suite and deploy script for CantonBridge
e28da6f feat(plasma): CantonBridge.sol with full production security
7eb06bc feat(plasma): add RateLimiter, bridge interfaces, and TokenRegistry
```

---

## What Is NOT Yet Done

1. **Canton → EVM withdrawal relay**: The contracts exist (`WithdrawalRequest`, `WithdrawalEvent`, `withdrawFromCanton` on Solidity), but the relayer does not watch Canton for withdrawal events. A second watcher service would be needed to poll Canton active contracts for `WithdrawalRequest`, submit a signed proof to `withdrawFromCanton`, then call `WithdrawalEvent.Complete`.

2. **Production deployment**: All config values are local (`localhost`). The `prod` profile in `configuration.ts` is wired but empty.

3. **Multi-token support**: `TokenConfig` is hardcoded to one `instrumentId` (`MockUSDC::canton`). Supporting multiple tokens would require either multiple `TokenConfig` contracts or a lookup by instrument ID.

4. **BridgeState scaling**: `processedTxHashes` is an ever-growing list in a single Daml contract. At high volume this will become a bottleneck. A sharded or archived approach would be needed.

5. **Subgraph Alchemy RPC**: The `FORK_RPC` in `local-setup.sh` is a specific Alchemy key. It should be moved to an env var.

---

## Claude Code Skills in This Repo

Located at `.claude/skills/<name>/SKILL.md`:

| Skill | When to use |
|---|---|
| `/bridge-setup` | Setting up the local stack from scratch, runbook |
| `/bridge-debug` | Debugging a stuck/failed bridge transaction |
| `/daml-bridge` | Canton/Daml patterns, SDK 3.4.11 quirks, v2 API reference |
| `/plasma-bridge` | Solidity reference, Foundry commands, test pitfalls |

---

## User Preferences (for Claude)

- **No "Co-Authored-By: Claude"** in git commits.
- Terse responses preferred — skip summaries of what was just done.
- Do not add docstrings/comments to code that wasn't changed.
- Do not add extra error handling, abstractions, or future-proofing beyond what was asked.
