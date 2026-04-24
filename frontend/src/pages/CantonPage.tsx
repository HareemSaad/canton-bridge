import { useState, useEffect, useCallback } from 'react';
import { TxTable } from '../components/TxTable';
import { getCantonBalance, getTransactions, submitWithdrawal } from '../lib/api';
import type { HoldingInfo, DepositTx, WithdrawalTx } from '../lib/api';

const STORAGE_KEY = 'canton-fp';
const TX_POLL_MS = 30_000;

function getSavedFp(): string {
  try { return sessionStorage.getItem(STORAGE_KEY) ?? ''; } catch { return ''; }
}

function formatCantonAmount(amount: string): string {
  const n = parseFloat(amount);
  return isNaN(n) ? amount : `${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 })} mUSDC`;
}

function shorten(s: string): string {
  return s.length <= 20 ? s : `${s.slice(0, 10)}…${s.slice(-8)}`;
}

export default function CantonPage() {
  const saved = getSavedFp();
  const [inputFp, setInputFp] = useState(saved);
  const [activeFp, setActiveFp] = useState(saved);

  const [holdingsLoading, setHoldingsLoading] = useState(false);
  const [holdingsError, setHoldingsError] = useState<string | null>(null);
  const [holdings, setHoldings] = useState<HoldingInfo[] | null>(null);

  const [txs, setTxs] = useState<{ deposits: DepositTx[]; withdrawals: WithdrawalTx[] } | null>(null);
  const [txLoading, setTxLoading] = useState(false);

  const [selectedHolding, setSelectedHolding] = useState<HoldingInfo | null>(null);
  const [evmRecipient, setEvmRecipient] = useState('');
  const [withdraw, setWithdraw] = useState<{ loading: boolean; updateId?: string; error?: string }>({ loading: false });

  const loadHoldings = useCallback(async (fp: string) => {
    setHoldingsLoading(true);
    setHoldingsError(null);
    try {
      const data = await getCantonBalance(fp);
      setHoldings(data.holdings);
    } catch (err: unknown) {
      setHoldingsError((err as Error).message ?? 'Failed to fetch holdings');
    } finally {
      setHoldingsLoading(false);
    }
  }, []);

  // showSpinner=false for silent background polls so the UI doesn't flicker
  const loadTxs = useCallback(async (fp: string, showSpinner = true) => {
    if (showSpinner) setTxLoading(true);
    try {
      const data = await getTransactions({ fingerprint: fp });
      setTxs(data);
    } catch { /* silently fail */ } finally {
      if (showSpinner) setTxLoading(false);
    }
  }, []);

  // Load both when activeFp changes (on lookup or on mount if saved fp exists)
  useEffect(() => {
    if (!activeFp) return;
    try { sessionStorage.setItem(STORAGE_KEY, activeFp); } catch { /* ignore */ }
    void loadHoldings(activeFp);
    void loadTxs(activeFp);
  }, [activeFp, loadHoldings, loadTxs]);

  // Silent 30s poll while fingerprint is active (matches relayer poll cycle)
  useEffect(() => {
    if (!activeFp) return;
    const id = setInterval(() => void loadTxs(activeFp, false), TX_POLL_MS);
    return () => clearInterval(id);
  }, [activeFp, loadTxs]);

  const handleLookup = useCallback(() => {
    const fp = inputFp.trim();
    if (!fp) return;
    setSelectedHolding(null);
    setWithdraw({ loading: false });
    if (fp === activeFp) {
      void loadHoldings(fp);
      void loadTxs(fp);
    } else {
      setActiveFp(fp);
    }
  }, [inputFp, activeFp, loadHoldings, loadTxs]);

  const handleWithdraw = async () => {
    if (!selectedHolding || !evmRecipient.trim() || !activeFp) return;
    setWithdraw({ loading: true });
    try {
      const result = await submitWithdrawal({
        fingerprint: activeFp,
        holdingId: selectedHolding.contractId,
        amount: selectedHolding.amount,
        evmRecipient: evmRecipient.trim(),
      });
      setWithdraw({ loading: false, updateId: result.updateId });
      setSelectedHolding(null);
      setEvmRecipient('');
      void loadHoldings(activeFp);
    } catch (err: unknown) {
      setWithdraw({ loading: false, error: (err as Error).message ?? 'Withdrawal failed' });
    }
  };

  const hasLoaded = holdings !== null || txs !== null;

  return (
    <div className="page">
      <section className="card">
        <h2>Canton Balance</h2>
        <p className="text-muted">
          Enter your Canton fingerprint to view holdings and bridge tokens back to Plasma.
        </p>
        <div className="lookup-row">
          <input
            type="text"
            className="input"
            placeholder="0x... (32-byte keccak256 fingerprint)"
            value={inputFp}
            onChange={(e) => setInputFp(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleLookup()}
          />
          <button
            className="btn btn-primary"
            onClick={handleLookup}
            disabled={holdingsLoading || !inputFp.trim()}
          >
            {holdingsLoading ? 'Loading…' : 'Lookup'}
          </button>
        </div>
        {holdingsError && <p className="error-msg">{holdingsError}</p>}
      </section>

      {hasLoaded && (
        <>
          <div className="actions-grid">
            <section className="card">
              <h2>Your Holdings</h2>
              {holdingsLoading ? (
                <p className="text-muted">Loading…</p>
              ) : holdings?.length === 0 ? (
                <p className="text-muted">No active holdings for this fingerprint.</p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  {holdings?.map((h) => (
                    <button
                      key={h.contractId}
                      onClick={() => {
                        setSelectedHolding(selectedHolding?.contractId === h.contractId ? null : h);
                        setWithdraw({ loading: false });
                      }}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        background: selectedHolding?.contractId === h.contractId
                          ? 'var(--accent-dim)' : 'var(--bg)',
                        border: `1px solid ${selectedHolding?.contractId === h.contractId
                          ? 'var(--accent)' : 'var(--border)'}`,
                        borderRadius: '8px',
                        padding: '10px 14px',
                        cursor: 'pointer',
                        textAlign: 'left',
                        color: 'var(--text)',
                        font: 'inherit',
                        transition: 'border-color 0.12s, background 0.12s',
                      }}
                    >
                      <span style={{ fontFamily: 'var(--mono)', fontSize: '12px', color: 'var(--text-muted)' }}>
                        {shorten(h.contractId)}
                      </span>
                      <span style={{ fontWeight: 600, color: 'var(--accent-hover)', whiteSpace: 'nowrap', marginLeft: '1rem' }}>
                        {formatCantonAmount(h.amount)}
                      </span>
                    </button>
                  ))}
                  <span className="field-hint">Click a holding to select it for withdrawal.</span>
                </div>
              )}
            </section>

            <section className="card">
              <h2>Bridge to Plasma</h2>
              {!selectedHolding ? (
                <p className="text-muted">Select a holding on the left to withdraw.</p>
              ) : (
                <>
                  <div className="form-group">
                    <label>Selected Holding</label>
                    <div style={{
                      background: 'var(--bg)',
                      border: '1px solid var(--border)',
                      borderRadius: '8px',
                      padding: '8px 12px',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                    }}>
                      <span style={{ fontFamily: 'var(--mono)', fontSize: '12px', color: 'var(--text-muted)' }}>
                        {shorten(selectedHolding.contractId)}
                      </span>
                      <span style={{ fontWeight: 600, color: 'var(--accent-hover)' }}>
                        {formatCantonAmount(selectedHolding.amount)}
                      </span>
                    </div>
                  </div>
                  <div className="form-group">
                    <label>EVM Recipient Address</label>
                    <input
                      type="text"
                      className="input"
                      placeholder="0x..."
                      value={evmRecipient}
                      onChange={(e) => setEvmRecipient(e.target.value)}
                    />
                    <span className="field-hint">Plasma address that will receive the unlocked tokens</span>
                  </div>
                  <button
                    className="btn btn-primary"
                    onClick={handleWithdraw}
                    disabled={withdraw.loading || !evmRecipient.trim()}
                  >
                    {withdraw.loading ? 'Submitting…' : 'Withdraw to Plasma'}
                  </button>
                </>
              )}
              {withdraw.updateId && (
                <p className="success-msg">
                  Queued — relayer processes within ~30s.
                  <br />
                  <span className="mono">{shorten(withdraw.updateId)}</span>
                </p>
              )}
              {withdraw.error && <p className="error-msg">{withdraw.error}</p>}
            </section>
          </div>

          <section className="card">
            <div className="card-header">
              <h2>Transaction History</h2>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => loadTxs(activeFp)}
                disabled={txLoading}
              >
                {txLoading ? 'Refreshing…' : 'Refresh'}
              </button>
            </div>
            <TxTable
              deposits={txs?.deposits ?? []}
              withdrawals={txs?.withdrawals ?? []}
              typeLabels={{ deposit: 'Receive', receive: 'Withdraw' }}
              emptyMessage="No transactions found for this fingerprint."
            />
          </section>
        </>
      )}
    </div>
  );
}
