# Canton-Plasma Bridge — POC

> **This is a proof-of-concept.** It is not audited, not production-ready, and uses mock tokens throughout. The purpose is to demonstrate the end-to-end mechanics of bridging an ERC-20 lock event on an EVM chain (Plasma) into a Daml token holding on Canton.

---

## What It Does

A user locks an ERC-20 token on Plasma by calling `Gateway.lock()`, specifying their Canton party ID as the recipient. An off-chain relayer detects the lock event via a subgraph, then submits a `CreateAndExercise` command to the Canton JSON Ledger API. This atomically creates a `BridgeReceiver` contract and exercises its `Mint` choice, which produces a `MockUSDCxHolding` on the Canton ledger owned by the recipient party.

```
User
 │
 ├─ approve(MockERC20 → Gateway)
 └─ Gateway.lock(token, amount, cantonRecipientPartyId, toChain)
                    │
                    ▼
             Locked event
                    │
                    ▼
           Subgraph (The Graph)
                    │
                    ▼
         Relayer (NestJS) ──── polls subgraph every 30s
                    │          stores PENDING row in Postgres
                    │
                    ▼
         Canton JSON Ledger API
           CreateAndExercise
             BridgeReceiver → Mint
                    │
                    ▼
         MockUSDCxHolding (owner = recipient)
```

---

## Components

| Directory | Description |
|---|---|
| `plasma/` | Solidity contracts — `Gateway.sol` (lock), `MockERC20.sol` (test token) |
| `subgraph/` | The Graph subgraph — indexes `Locked` events from Gateway |
| `relayer/` | NestJS service — polls subgraph, relays to Canton, tracks status in Postgres |
| `canton/` | Daml contracts — `BridgeReceiver` (mint logic), `MockUSDCx` (token), `Main` (party setup) |
| `scripts/` | Shell scripts for local dev lifecycle |

---

## Prerequisites

| Tool | Version |
|---|---|
| Node.js | 18+ |
| Yarn | any |
| Docker Desktop | running |
| Foundry (`forge`, `cast`) | latest stable |
| Daml SDK | 3.4.11 |
| Python | 3.x |

Install Daml SDK:
```bash
curl -sSL https://get.daml.com/ | sh -s 3.4.11
```

---

## Local Setup

### 1. Configure environment

```bash
cp plasma/.env.example plasma/.env
```

Edit `plasma/.env` and fill in your `PRIVATE_KEY` (any Anvil dev key works for local testing).

### 2. Start the full stack

```bash
./scripts/local-setup.sh
```

This single script:
- Forks the Plasma testnet with Anvil
- Deploys `Gateway` and `MockERC20`, whitelists both
- Patches and deploys the subgraph to a local Graph node (Docker)
- Starts a Postgres instance for the relayer
- Builds the Canton DAR and starts the Canton sandbox
- Allocates `BridgeOperator`, `User1`, `User2` parties
- Writes a fully-configured `relayer/.env`

Leave this terminal running (Ctrl-C tears everything down).

### 3. Start the relayer

In a second terminal:

```bash
cd relayer
yarn install
yarn start:dev
```

The relayer polls the subgraph every 30 seconds and submits pending transactions to Canton every 60 seconds.

### 4. Run the end-to-end test

In a third terminal:

```bash
./scripts/e2e-test.sh
```

This approves and locks 1 mUSDCx on Plasma with `User1` as the Canton recipient, then waits for the relayer to relay it and confirms a `MockUSDCxHolding` appears on the Canton ledger owned by `User1`.

### 5. Inspect Canton transactions (optional)

```bash
./scripts/canton-txns.sh
```

### 6. Tear everything down

```bash
./scripts/teardown.sh
```

---

## Scripts Reference

| Script | When to use |
|---|---|
| `scripts/local-setup.sh` | **First** — bootstraps the entire local stack. Run once per session. Keeps Anvil and Canton alive in the foreground. |
| `scripts/teardown.sh` | **Last** — stops Docker stacks, kills Anvil, Canton, and the relayer. Safe to run at any time. |
| `scripts/e2e-test.sh` | After `local-setup.sh` is done and `yarn start:dev` is running. Locks tokens on Plasma and verifies the Canton holding. |
| `scripts/canton-txns.sh` | Anytime the stack is running. Prints all bridge transactions recorded on the Canton ledger. |

---

## Relayer Logs

```bash
tail -f /tmp/relayer.log | grep -E "Inserted|relay|RELAYED|FAILED"
```

## Canton Logs

Canton's JVM startup log:
```bash
tail -f /tmp/canton-sandbox.log
```

All bridge transactions on the ledger:
```bash
./scripts/canton-txns.sh
```

---

## Bridge Transaction Status

Each lock event moves through the following states in the relayer's Postgres database:

| Status | Meaning |
|---|---|
| `PENDING` | Lock event indexed from subgraph, waiting for Canton relay |
| `RELAYED` | `CreateAndExercise` submitted to Canton; `canton_tx_id` populated |
| `FAILED` | Canton submission failed (check relayer logs) |

---

## Known Limitations (POC)

- `FAILED` rows are not retried automatically
- No JWT authentication on the Canton sandbox (uses `userId: sandbox`)
- Mock tokens only — `MockERC20` on Plasma, `MockUSDCxHolding` on Canton
- Single-direction bridge (Plasma → Canton only)
- No unlock / burn flow
