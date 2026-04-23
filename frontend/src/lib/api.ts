import { RELAYER_URL } from './constants';

const API = RELAYER_URL;

export type DepositTx = {
  id: string;
  direction: 'plasma_to_canton';
  transactionHash: string;
  cantonTxId: string | null;
  amount: string;
  status: string;
  depositor: string | null;
  recipient: string;
  blockTimestamp: string;
};

export type WithdrawalTx = {
  contractId: string;
  direction: 'canton_to_plasma';
  evmTxHash?: string;
  amount: string;
  evmRecipient: string;
  fingerprint: string;
  status: 'pending' | 'completed' | 'failed';
};

export async function getPlasmaBalance(address: string): Promise<{ balance: string; decimals: number; token: string }> {
  const res = await fetch(`${API}/plasma/balance?address=${address}`);
  if (!res.ok) throw new Error('Failed to fetch balance');
  return res.json();
}

export async function requestFaucet(address: string): Promise<{ txHash: string; amount: string }> {
  const res = await fetch(`${API}/plasma/faucet?address=${address}`, { method: 'POST' });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.message ?? 'Faucet failed');
  return data;
}

export async function getTransactions(params: {
  depositor?: string;
  evmRecipient?: string;
  fingerprint?: string;
}): Promise<{ deposits: DepositTx[]; withdrawals: WithdrawalTx[] }> {
  const p = new URLSearchParams();
  if (params.depositor) p.set('depositor', params.depositor);
  if (params.evmRecipient) p.set('evmRecipient', params.evmRecipient);
  if (params.fingerprint) p.set('fingerprint', params.fingerprint);
  const res = await fetch(`${API}/transactions?${p}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data?.message ?? 'Failed to fetch transactions');
  return data;
}
