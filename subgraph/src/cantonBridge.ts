import { Bytes, store } from "@graphprotocol/graph-ts";
import {
  DepositToCanton as DepositToCantonEvent,
  TokenRegistered as TokenRegisteredEvent,
  TokenDeregistered as TokenDeregisteredEvent,
} from "../generated/CantonBridge/CantonBridge";
import { Deposit, TokenRegistration } from "../generated/schema";

// ── DepositToCanton ──────────────────────────────────────────────────────────

export function handleDeposit(event: DepositToCantonEvent): void {
  const id =
    event.transaction.hash.toHexString() +
    "-" +
    event.logIndex.toString();

  const entity = new Deposit(id);
  entity.token       = event.params.token;
  entity.user        = event.params.user;
  entity.amount      = event.params.amount;
  entity.fingerprint = event.params.fingerprint;
  entity.nonce       = event.params.nonce;
  entity.blockNumber     = event.block.number;
  entity.blockTimestamp  = event.block.timestamp;
  entity.transactionHash = event.transaction.hash;
  entity.save();
}

// ── Token registry events ────────────────────────────────────────────────────

export function handleTokenRegistered(event: TokenRegisteredEvent): void {
  const id = event.params.token.toHexString();

  let entity = TokenRegistration.load(id);
  if (entity == null) {
    entity = new TokenRegistration(id);
  }
  entity.token     = event.params.token;
  entity.symbol    = event.params.symbol;
  entity.cip56Id   = event.params.cip56Id;
  entity.active    = true;
  entity.blockNumber     = event.block.number;
  entity.blockTimestamp  = event.block.timestamp;
  entity.transactionHash = event.transaction.hash;
  entity.save();
}

export function handleTokenDeregistered(event: TokenDeregisteredEvent): void {
  const id = event.params.token.toHexString();
  const entity = TokenRegistration.load(id);
  if (entity != null) {
    entity.active = false;
    entity.save();
  }
}
