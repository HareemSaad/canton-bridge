import { BigInt } from "@graphprotocol/graph-ts";
import { locked } from "../generated/Gateway/Gateway";
import { Lock } from "../generated/schema";

export function handleLocked(event: locked): void {
  let entity = new Lock(event.params.nonce.toString());

  entity.nonce = event.params.nonce;
  entity.token = event.params.token;
  entity.amount = event.params.amount;
  entity.recipient = event.params.recipient;
  entity.toChain = event.params.toChain;

  entity.blockNumber = event.block.number;
  entity.blockTimestamp = event.block.timestamp;
  entity.transactionHash = event.transaction.hash;

  entity.save();
}
