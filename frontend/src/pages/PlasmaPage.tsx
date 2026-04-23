import { useState, useEffect, useCallback } from 'react';
import { ethers } from 'ethers';
import { useWallet } from '../hooks/useWallet';
import { TxTable } from '../components/TxTable';
import { getPlasmaBalance, requestFaucet, getTransactions } from '../lib/api';
import type { DepositTx, WithdrawalTx } from '../lib/api';
import {
  CANTON_BRIDGE_ADDRESS,
  EVM_TOKEN_ADDRESS,
  CANTON_BRIDGE_ABI,
  ERC20_ABI,
  TOKEN_DECIMALS,
} from '../lib/constants';

function parseAmount(input: string): bigint {
  if (!input) return 0n;
  const [whole, frac = ''] = input.split('.');
  const fracPadded = frac.padEnd(TOKEN_DECIMALS, '0').slice(0, TOKEN_DECIMALS);
  return BigInt(whole || '0') * BigInt(10 ** TOKEN_DECIMALS) + BigInt(fracPadded || '0');
}

function formatBalance(raw: string, decimals: number): string {
  try {
    const b = BigInt(raw);
    const d = BigInt(10 ** decimals);
    const whole = b / d;
    const frac = (b % d).toString().padStart(decimals, '0');
    return `${whole}.${frac}`;
  } catch {
    return '0.000000';
  }
}

export default function PlasmaPage() {
  const wallet = useWallet();

  const [balance, setBalance] = useState<{ raw: string; decimals: number } | null>(null);
  const [faucet, setFaucet] = useState<{ loading: boolean; txHash?: string; error?: string }>({ loading: false });
  const [amount, setAmount] = useState('');
  const [fingerprint, setFingerprint] = useState('');
  const [bridge, setBridge] = useState<{ loading: boolean; txHash?: string; error?: string; step?: string }>({ loading: false });
  const [txs, setTxs] = useState<{ deposits: DepositTx[]; withdrawals: WithdrawalTx[] } | null>(null);
  const [txLoading, setTxLoading] = useState(false);
  const [txError, setTxError] = useState<string | null>(null);

  const loadBalance = useCallback(async () => {
    if (!wallet.address) return;
    try {
      const b = await getPlasmaBalance(wallet.address);
      setBalance({ raw: b.balance, decimals: b.decimals });
    } catch { /* silently fail */ }
  }, [wallet.address]);

  const loadTransactions = useCallback(async () => {
    if (!wallet.address) return;
    setTxLoading(true);
    setTxError(null);
    try {
      const data = await getTransactions({ depositor: wallet.address, evmRecipient: wallet.address });
      setTxs(data);
    } catch (err: unknown) {
      setTxError((err as Error).message ?? 'Failed to load transactions');
    } finally {
      setTxLoading(false);
    }
  }, [wallet.address]);

  useEffect(() => {
    if (wallet.address) {
      loadBalance();
      loadTransactions();
    }
  }, [wallet.address, loadBalance, loadTransactions]);

  const handleFaucet = async () => {
    if (!wallet.address) return;
    setFaucet({ loading: true });
    try {
      const result = await requestFaucet(wallet.address);
      setFaucet({ loading: false, txHash: result.txHash });
      await loadBalance();
    } catch (err: unknown) {
      setFaucet({ loading: false, error: (err as Error).message });
    }
  };

  const handleBridge = async () => {
    if (!wallet.signer || !wallet.address) return;

    let fp = fingerprint.trim();
    if (!fp.startsWith('0x')) fp = '0x' + fp;
    if (fp.length !== 66) {
      setBridge({ loading: false, error: 'Fingerprint must be 32 bytes (64 hex chars)' });
      return;
    }

    const rawAmount = parseAmount(amount);
    if (rawAmount === 0n) {
      setBridge({ loading: false, error: 'Amount must be greater than 0' });
      return;
    }

    setBridge({ loading: true, step: 'Checking allowance…' });
    try {
      const erc20 = new ethers.Contract(EVM_TOKEN_ADDRESS, ERC20_ABI, wallet.signer);
      const allowance = await erc20.allowance(wallet.address, CANTON_BRIDGE_ADDRESS) as bigint;

      if (allowance < rawAmount) {
        setBridge({ loading: true, step: 'Approving tokens…' });
        const approveTx = await erc20.approve(CANTON_BRIDGE_ADDRESS, rawAmount) as ethers.TransactionResponse;
        await approveTx.wait();
      }

      setBridge({ loading: true, step: 'Bridging to Canton…' });
      const bridgeContract = new ethers.Contract(CANTON_BRIDGE_ADDRESS, CANTON_BRIDGE_ABI, wallet.signer);
      const tx = await bridgeContract.depositToCanton(EVM_TOKEN_ADDRESS, rawAmount, fp) as ethers.TransactionResponse;
      const receipt = await tx.wait();

      setBridge({ loading: false, txHash: receipt?.hash ?? tx.hash });
      setAmount('');
      setFingerprint('');
      await loadBalance();
      setTimeout(loadTransactions, 2000);
    } catch (err: unknown) {
      setBridge({ loading: false, error: (err as Error).message ?? 'Bridge failed' });
    }
  };

  return (
    <div className="page">
      <section className="card">
        <div className="card-header">
          <h2>Wallet</h2>
          {wallet.address && balance && (
            <span className="balance-chip">
              {formatBalance(balance.raw, balance.decimals)} mUSDC
            </span>
          )}
        </div>

        {!wallet.isConnected ? (
          <div className="connect-area">
            <p className="text-muted">Connect your MetaMask wallet to use the Plasma bridge.</p>
            <button className="btn btn-primary" onClick={wallet.connect} disabled={wallet.isConnecting}>
              {wallet.isConnecting ? 'Connecting…' : 'Connect MetaMask'}
            </button>
            {wallet.error && <p className="error-msg">{wallet.error}</p>}
          </div>
        ) : (
          <div className="address-display">
            <span className="dot-green" />
            <span className="address">{wallet.address}</span>
          </div>
        )}
      </section>

      {wallet.isConnected && (
        <>
          <div className="actions-grid">
            <section className="card">
              <h2>Test Tokens</h2>
              <p className="text-muted">Mint 1,000 mUSDC to your wallet for testing.</p>
              <button className="btn btn-secondary" onClick={handleFaucet} disabled={faucet.loading}>
                {faucet.loading ? 'Minting…' : 'Get 1,000 mUSDC'}
              </button>
              {faucet.txHash && (
                <p className="success-msg">
                  Minted! Tx: <span className="mono">{faucet.txHash.slice(0, 16)}…</span>
                </p>
              )}
              {faucet.error && <p className="error-msg">{faucet.error}</p>}
            </section>

            <section className="card">
              <h2>Bridge to Canton</h2>
              <div className="form-group">
                <label>Amount (mUSDC)</label>
                <input
                  type="number"
                  className="input"
                  placeholder="100"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  min="0"
                  step="any"
                />
              </div>
              <div className="form-group">
                <label>Canton Fingerprint (bytes32)</label>
                <input
                  type="text"
                  className="input"
                  placeholder="0x..."
                  value={fingerprint}
                  onChange={(e) => setFingerprint(e.target.value)}
                />
                <span className="field-hint">keccak256 hash identifying your Canton party</span>
              </div>
              <button className="btn btn-primary" onClick={handleBridge} disabled={bridge.loading || !amount || !fingerprint}>
                {bridge.loading ? (bridge.step ?? 'Processing…') : 'Bridge to Canton'}
              </button>
              {bridge.txHash && (
                <p className="success-msg">
                  Deposited! Tx: <span className="mono">{bridge.txHash.slice(0, 16)}…</span>
                </p>
              )}
              {bridge.error && <p className="error-msg">{bridge.error}</p>}
            </section>
          </div>

          <section className="card">
            <div className="card-header">
              <h2>Transactions</h2>
              <button className="btn btn-ghost btn-sm" onClick={loadTransactions} disabled={txLoading}>
                {txLoading ? 'Refreshing…' : 'Refresh'}
              </button>
            </div>
            {txError && <p className="error-msg">{txError}</p>}
            <TxTable
              deposits={txs?.deposits ?? []}
              withdrawals={txs?.withdrawals ?? []}
              emptyMessage="No transactions yet. Bridge some tokens to get started."
            />
          </section>
        </>
      )}
    </div>
  );
}
