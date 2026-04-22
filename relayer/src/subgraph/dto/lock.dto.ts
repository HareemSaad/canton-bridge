// ── Production: DepositToCanton events from CantonBridge ─────────────────────

export interface DepositDto {
  id: string;
  nonce: string;
  token: string;
  amount: string;
  fingerprint: string;   // bytes32 hex (the Canton party fingerprint)
  user: string;          // EVM depositor address
  blockNumber: string;
  blockTimestamp: string;
  transactionHash: string;
}

export interface FetchDepositsResponse {
  deposits: DepositDto[];
}

// ── Legacy: locked events from Gateway (kept for backward compat) ─────────────

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
