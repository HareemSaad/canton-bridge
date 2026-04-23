import { useState } from 'react';
import { TxTable } from '../components/TxTable';
import { getTransactions } from '../lib/api';
import type { DepositTx, WithdrawalTx } from '../lib/api';

export default function CantonPage() {
  const [fingerprint, setFingerprint] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [txs, setTxs] = useState<{ deposits: DepositTx[]; withdrawals: WithdrawalTx[] } | null>(null);

  const handleLookup = async () => {
    const fp = fingerprint.trim();
    if (!fp) return;
    setLoading(true);
    setError(null);
    try {
      const data = await getTransactions({ fingerprint: fp });
      setTxs(data);
    } catch (err: unknown) {
      setError((err as Error).message ?? 'Failed to fetch transactions');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="page">
      <section className="card">
        <h2>Canton Transaction Lookup</h2>
        <p className="text-muted">
          Paste your Canton fingerprint (EVM bytes32 keccak256 hash) to view all bridge
          transactions associated with your Canton account.
        </p>
        <div className="lookup-row">
          <input
            type="text"
            className="input"
            placeholder="0x... or 64-char hex"
            value={fingerprint}
            onChange={(e) => setFingerprint(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleLookup()}
          />
          <button
            className="btn btn-primary"
            onClick={handleLookup}
            disabled={loading || !fingerprint.trim()}
          >
            {loading ? 'Loading…' : 'Lookup'}
          </button>
        </div>
        {error && <p className="error-msg">{error}</p>}
      </section>

      {txs && (
        <section className="card">
          <div className="card-header">
            <h2>Transactions</h2>
            <span className="text-muted">
              {txs.deposits.length + txs.withdrawals.length} total
            </span>
          </div>
          <TxTable
            deposits={txs.deposits}
            withdrawals={txs.withdrawals}
            emptyMessage="No transactions found for this fingerprint."
          />
        </section>
      )}
    </div>
  );
}
