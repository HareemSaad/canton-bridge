---
name: daml-bridge
description: Canton/Daml development for the canton-bridge project. Use when writing, reviewing, or debugging Daml templates — CIP-56 holdings, FingerprintAuth, BridgeState, MintCommand, or daml.yaml changes.
---

# Daml Bridge Development

You are working in `canton/daml/` of the canton-bridge project. This uses **Daml SDK 3.4.11** with the CIP-56 token standard.

## Module Layout

```
canton/daml/
  Main.daml               — setup script (allocates parties, prints contract IDs)
  CIP56/
    Token.daml            — CIP56Holding + CIP56Manager (UTXO token model)
    Config.daml           — TokenConfig (IssuerMint / IssuerBurn authority)
    Events.daml           — TokenTransferEvent (audit log)
    Compliance.daml       — ComplianceRules + ComplianceProof
  Common/
    Types.daml            — EvmAddress, ChainRef, BridgeDirection, TokenMeta newtypes
    Utils.daml            — isValidAmount, isValidEvmAddress, hasSufficientBalance
    FingerprintAuth.daml  — FingerprintMapping only (PendingDeposit/DepositReceipt removed)
  Bridge/
    State.daml            — BridgeState (processedTxHashes replay guard)
    Contracts.daml        — MintCommand, DepositToPlasma, DepositToPlasmaEvent
```

## Key Patterns

### Observer lists — DO NOT use `DA.List.nub`
SDK 3.4.11 does not export `nub` from `DA.List`. Deduplicate with filter or case:

```daml
-- WRONG
import DA.List (nub)
observer nub (fromParty : toParty : [])

-- CORRECT
observer case fromParty of None -> []; Some p -> [p]
```

### DA.Text.length — must import explicitly
```daml
import DA.Text (length)
```

### TextMap — use qualified import
```daml
import DA.TextMap qualified as TextMap
TextMap.fromList [("key", "value")]
```

### Debug output format
`debug $ "KEY=" <> show someContractId` produces a line like:
```
[DA.Internal.Prelude:555]: "KEY=00abc123..."
```
Parse in bash with: `grep -oP '(?<=KEY=)[^"\\n]+'`

### Nonconsuming choices
```daml
nonconsuming choice MyChoice : ReturnType
  with arg : Text
  controller issuer
  do ...
```

### ContractId in show output
`show (cid : ContractId T)` → raw hex string like `"00abc123::0"` (no type wrapper).

## Build and Test

```bash
cd canton
daml build                    # builds .daml/dist/canton-bridge-1.0.0.dar
daml test                     # runs all Script tests
daml sandbox --port 6865 --json-api-port 7575 --dar .daml/dist/canton-bridge-1.0.0.dar
daml script --dar .daml/dist/canton-bridge-1.0.0.dar \
  --script-name "Main:setup" \
  --ledger-host localhost --ledger-port 6865 \
  --wall-clock-time
```

## Canton v2 HTTP API — Common Patterns

### Get ledger offset (required before active-contracts)
```bash
curl http://localhost:7575/v2/state/ledger-end
# → { "offset": "42" }
```

### Query active contracts (no template filter — filter in code)
```bash
OFFSET=$(curl -s http://localhost:7575/v2/state/ledger-end | python3 -c "import json,sys; print(json.load(sys.stdin)['offset'])")
curl -s -X POST http://localhost:7575/v2/state/active-contracts \
  -H "Content-Type: application/json" \
  -d "{\"activeAtOffset\":\"$OFFSET\",\"filter\":{\"filtersByParty\":{\"$PARTY\":{}}}}"
# → JSON array of { contractEntry: { JsActiveContract: { createdEvent: { templateId, createArgument } } } }
```

**NOTE:** The v2 `templateFilters` schema requires an `identifierFilter` field and `cumulative` must be an array. Avoid template filters — filter by `templateId.includes('TemplateName')` in code instead.

### Submit a command
```bash
curl -X POST http://localhost:7575/v2/commands/submit-and-wait \
  -H "Content-Type: application/json" \
  -d '{
    "actAs": ["<partyId>"],
    "userId": "sandbox",
    "commandId": "unique-id",
    "commands": [
      {
        "CreateCommand": {
          "templateId": "#canton-bridge:Module.Name:TemplateName",
          "createArguments": { ... }
        }
      }
    ]
  }'
```

### Exercise a choice
```bash
# In commands array:
{
  "ExerciseCommand": {
    "contractId": "<contractId>",
    "templateId": "#canton-bridge:Bridge.Contracts:MintCommand",
    "choice": "Execute",
    "choiceArgument": {}
  }
}
```

## Party Allocation (Canton v2 API)

```bash
# Allocate a new party with a hint
curl -X POST http://localhost:7575/v2/parties \
  -H "Content-Type: application/json" \
  -d '{ "partyIdHint": "alice", "displayName": "alice" }'
# → { "partyDetails": { "party": "alice::122...", "displayName": "alice" } }
```

**`POST /canton/party/connect`** (relayer endpoint) wraps this:
- Computes `fingerprint = keccak256(utf8(username)).slice(2)` (no 0x, same as `cast keccak "username"`)
- Checks for existing `FingerprintMapping` first (idempotent)
- If not found: allocates party via `/v2/parties`, then creates `FingerprintMapping` via `submit-and-wait`
- Returns `{ partyId, fingerprint, created }`

`createFingerprintMapping` body pattern:
```json
{
  "actAs": ["<bridgeOperatorPartyId>"],
  "userId": "sandbox",
  "commandId": "create-fp-<first8hex>-<timestamp>",
  "commands": [{
    "CreateCommand": {
      "templateId": "#canton-bridge:Common.FingerprintAuth:FingerprintMapping",
      "createArguments": {
        "issuer": "<bridgeOperatorPartyId>",
        "userParty": "<newPartyId>",
        "fingerprint": "<64-char-hex-no-0x>",
        "evmAddress": null
      }
    }
  }]
}
```

## Partial / Multi-holding Withdrawal Flow (Canton → Plasma)

`POST /canton/withdraw` body: `{ fingerprint, holdingIds: string[], amount, evmRecipient }`

The relayer (`canton.service.ts → createWithdrawal`) performs any necessary reshaping before creating `DepositToPlasma`:

### Merge (multiple holdings → one)
```typescript
// actAs: userParty — controller owner on CIP56Holding.Merge
{
  ExerciseCommand: {
    templateId: '#canton-bridge:CIP56.Token:CIP56Holding',
    contractId: currentId,
    choice: 'Merge',
    choiceArgument: { otherId }
  }
}
// After each merge: re-query user holdings, find new contractId not in before-set
```

### Split (one holding → exact amount + remainder)
```typescript
// actAs: userParty — controller owner on CIP56Holding.Split
{
  ExerciseCommand: {
    templateId: '#canton-bridge:CIP56.Token:CIP56Holding',
    contractId: holdingId,
    choice: 'Split',
    choiceArgument: { splitAmount: '20.000000' }  // Canton Decimal string
  }
}
// After split: re-query, find new contractId where amountRaw === splitRaw
```

**Key**: new contract IDs after Merge/Split are found by diffing the set of user holdings before and after, not by parsing the exercise result.

### In-flight holding exclusion
`getHoldingsByFingerprint` / `getHoldingsByParty` in `canton-query.service.ts` call `collectLockedHoldingIds()` which scans active contracts for `DepositToPlasma` (not `DepositToPlasmaEvent`) and collects their `holdingId` fields. These are excluded from the returned balance — they appear "pending" in the withdrawal but are not yet burned by the watcher.

## MintCommand Flow (Plasma → Canton)

1. Relayer picks up `DepositToCanton` event (fingerprint, amount, txHash)
2. Fetches ledger-end offset
3. Queries all active contracts for BridgeOperator party
4. Finds `FingerprintMapping` where `createArgument.fingerprint == depositFingerprint`
5. Resolves `userParty` from the mapping
6. Submits `CreateAndExercise MintCommand Execute`:
   - `bridgeStateId.RecordMint(txHash)` — replay guard (fails if duplicate)
   - `tokenConfigId.IssuerMint(recipient, amount, txHash, meta)` → creates `CIP56Holding`
   - Creates `TokenTransferEvent` for audit

## FingerprintMapping Convention

- Stored fingerprint: hex string **without** `0x` prefix (e.g. `"9267b5b6..."`)
- EVM deposit: `bytes32` **with** `0x` prefix (e.g. `0x9267b5b6...`)
- Relayer strips `0x` before comparing
- Local dev fingerprints use `cast keccak "User1"` (deterministic)

## Common Errors

| Error | Cause | Fix |
|---|---|---|
| `Module 'DA.List' does not export 'nub'` | SDK 3.4.11 removed nub | Use `filter (== x)` or case expression |
| `DA.Text.length not in scope` | Needs explicit import | `import DA.Text (length)` |
| Canton 400 `expecting array at 'cumulative'` | cumulative must be array | Use `cumulative: [{ templateFilters: [...] }]` or skip template filter |
| Canton 400 `Missing required field at 'activeAtOffset'` | active-contracts needs offset | Fetch `/v2/state/ledger-end` first |
| Canton 400 `Missing required field at 'identifierFilter'` | templateFilters needs identifierFilter | Skip template filter; filter by templateId in code |
| `No FingerprintMapping found` | Placeholder fingerprint still active | Check that local-setup.sh ran the Remove+Create steps |
