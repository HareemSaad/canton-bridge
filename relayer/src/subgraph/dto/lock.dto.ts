export interface LockDto {
  id: string;
  nonce: string;
  token: string;
  amount: string;
  recipient: string;
  toChain: string;
  blockNumber: string;
  blockTimestamp: string;
  transactionHash: string;
}

export interface FetchLocksResponse {
  locks: LockDto[];
}
