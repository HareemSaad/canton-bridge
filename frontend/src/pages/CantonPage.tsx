import { useState, useEffect, useCallback } from 'react';
import { TxTable } from '../components/TxTable';
import { connectCantonParty, getCantonBalance, getTransactions, submitWithdrawal } from '../lib/api';
import type { HoldingInfo, DepositTx, WithdrawalTx } from '../lib/api';

const SESSION_KEY = 'canton-session';
const TX_POLL_MS = 30_000;

type CantonSession = { username: string; partyId: string; fingerprint: string };

function loadSession(): CantonSession | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as CantonSession) : null;
  } catch { return null; }
}

function saveSession(s: CantonSession) {
  try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch { /* ignore */ }
}

function clearSession() {
  try { sessionStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
}

function formatCantonAmount(amount: string): string {
  const n = parseFloat(amount);
  return isNaN(n) ? amount : `${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 })} mUSDC`;
}

function shorten(s: string): string {
  return s.length <= 20 ? s : `${s.slice(0, 10)}…${s.slice(-8)}`;
}

export default function CantonPage() {
  const [session, setSession] = useState<CantonSession | null>(loadSession);
  const [usernameInput, setUsernameInput] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Holdings & tx state — driven by session.fingerprint
  const [activeFp, setActiveFp] = useState(session?.fingerprint ?? '');
  const [holdingsLoading, setHoldingsLoading] = useState(false);
  const [holdingsError, setHoldingsError] = useState<string | null>(null);
  const [holdings, setHoldings] = useState<HoldingInfo[] | null>(null);

  const [txs, setTxs] = useState<{ deposits: DepositTx[]; withdrawals: WithdrawalTx[] } | null>(null);
  const [txLoading, setTxLoading] = useState(false);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [withdrawAmount, setWithdrawAmount] = useState('');
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

  const loadTxs = useCallback(async (fp: string, showSpinner = true) => {
    if (showSpinner) setTxLoading(true);
    try {
      const data = await getTransactions({ fingerprint: fp });
      setTxs(data);
    } catch { /* silently fail */ } finally {
      if (showSpinner) setTxLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!activeFp) return;
    void loadHoldings(activeFp);
    void loadTxs(activeFp);
  }, [activeFp, loadHoldings, loadTxs]);

  useEffect(() => {
    if (!activeFp) return;
    const id = setInterval(() => void loadTxs(activeFp, false), TX_POLL_MS);
    return () => clearInterval(id);
  }, [activeFp, loadTxs]);

  const handleConnect = async () => {
    const name = usernameInput.trim();
    if (!name) return;
    setConnecting(true);
    setConnectError(null);
    try {
      const { partyId, fingerprint } = await connectCantonParty(name);
      const s: CantonSession = { username: name, partyId, fingerprint };
      saveSession(s);
      setSession(s);
      setActiveFp(fingerprint);
      setSelectedIds(new Set());
      setWithdrawAmount('');
      setWithdraw({ loading: false });
      setHoldings(null);
      setTxs(null);
    } catch (err: unknown) {
      setConnectError((err as Error).message ?? 'Failed to connect');
    } finally {
      setConnecting(false);
    }
  };

  const handleDisconnect = () => {
    clearSession();
    setSession(null);
    setActiveFp('');
    setHoldings(null);
    setTxs(null);
    setSelectedIds(new Set());
    setWithdrawAmount('');
    setWithdraw({ loading: false });
    setUsernameInput('');
  };

  const handleCopyKey = () => {
    if (!session) return;
    void navigator.clipboard.writeText(`0x${session.fingerprint}`).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  // Decimal helpers (mirrors relayer logic, 6 decimals)
  const parseDecimal = (s: string): bigint => {
    const [whole, frac = ''] = s.split('.');
    return BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, '0').slice(0, 6));
  };
  const formatDecimal = (raw: bigint): string =>
    `${raw / 1_000_000n}.${(raw % 1_000_000n).toString().padStart(6, '0')}`;

  const selectedHoldings = (holdings ?? []).filter((h) => selectedIds.has(h.contractId));
  const totalSelectedRaw = selectedHoldings.reduce((acc, h) => acc + parseDecimal(h.amount), 0n);

  const toggleHolding = (h: HoldingInfo) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(h.contractId)) {
        next.delete(h.contractId);
      } else {
        next.add(h.contractId);
      }
      return next;
    });
    // Reset amount to total whenever selection changes
    setWithdrawAmount('');
    setWithdraw({ loading: false });
  };

  const effectiveAmount = withdrawAmount.trim() || (totalSelectedRaw > 0n ? formatDecimal(totalSelectedRaw) : '');
  const amountRaw = effectiveAmount ? (() => { try { return parseDecimal(effectiveAmount); } catch { return 0n; } })() : 0n;
  const amountValid = amountRaw > 0n && amountRaw <= totalSelectedRaw;

  const handleWithdraw = async () => {
    if (!selectedIds.size || !amountValid || !evmRecipient.trim() || !activeFp) return;
    setWithdraw({ loading: true });
    try {
      const result = await submitWithdrawal({
        fingerprint: activeFp,
        holdingIds: [...selectedIds],
        amount: effectiveAmount,
        evmRecipient: evmRecipient.trim(),
      });
      setWithdraw({ loading: false, updateId: result.updateId });
      setSelectedIds(new Set());
      setWithdrawAmount('');
      setEvmRecipient('');
      void loadHoldings(activeFp);
    } catch (err: unknown) {
      setWithdraw({ loading: false, error: (err as Error).message ?? 'Withdrawal failed' });
    }
  };

  const hasLoaded = holdings !== null || txs !== null;

  return (
    <div className="page">
      {/* ── Wallet section ──────────────────────────────────────────── */}
      <section className="card">
        <h2>Canton Wallet</h2>

        {!session ? (
          <>
            <p className="text-muted">
              Enter a username to create or connect your Canton wallet.
              New users get a fresh Canton party; returning users reconnect to their existing one.
            </p>
            <div className="lookup-row">
              <input
                type="text"
                className="input"
                placeholder="e.g. alice"
                value={usernameInput}
                onChange={(e) => setUsernameInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void handleConnect()}
                disabled={connecting}
              />
              <button
                className="btn btn-primary"
                onClick={() => void handleConnect()}
                disabled={connecting || !usernameInput.trim()}
              >
                {connecting ? 'Connecting…' : 'Create / Connect'}
              </button>
            </div>
            {connectError && <p className="error-msg">{connectError}</p>}
          </>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <span style={{ color: 'var(--accent-hover)', fontWeight: 600 }}>✓ Connected as: {session.username}</span>
            </div>
            <div className="form-group" style={{ margin: 0 }}>
              <label>Canton Party</label>
              <div style={{
                background: 'var(--bg)',
                border: '1px solid var(--border)',
                borderRadius: '8px',
                padding: '8px 12px',
                fontFamily: 'var(--mono)',
                fontSize: '12px',
                color: 'var(--text-muted)',
                wordBreak: 'break-all',
              }}>
                {session.partyId}
              </div>
            </div>
            <div className="form-group" style={{ margin: 0 }}>
              <label>Bridge Key (EVM bytes32)</label>
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
              }}>
                <div style={{
                  flex: 1,
                  background: 'var(--bg)',
                  border: '1px solid var(--border)',
                  borderRadius: '8px',
                  padding: '8px 12px',
                  fontFamily: 'var(--mono)',
                  fontSize: '12px',
                  color: 'var(--text-muted)',
                  wordBreak: 'break-all',
                }}>
                  {`0x${session.fingerprint}`}
                </div>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={handleCopyKey}
                  style={{ whiteSpace: 'nowrap' }}
                >
                  {copied ? 'Copied!' : 'Copy'}
                </button>
              </div>
              <span className="field-hint">Paste this as the fingerprint when depositing on the Plasma page.</span>
            </div>
            <div>
              <button className="btn btn-ghost btn-sm" onClick={handleDisconnect}>
                Disconnect
              </button>
            </div>
          </div>
        )}
      </section>

      {/* ── Holdings + Withdrawal + Txs (unchanged, driven by activeFp) ── */}
      {hasLoaded && (
        <>
          <div className="actions-grid">
            <section className="card">
              <h2>Your Holdings</h2>
              {holdingsLoading ? (
                <p className="text-muted">Loading…</p>
              ) : holdings?.length === 0 ? (
                <p className="text-muted">No active holdings for this account.</p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  {holdings?.map((h) => {
                    const selected = selectedIds.has(h.contractId);
                    return (
                      <button
                        key={h.contractId}
                        onClick={() => toggleHolding(h)}
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          background: selected ? 'var(--accent-dim)' : 'var(--bg)',
                          border: `1px solid ${selected ? 'var(--accent)' : 'var(--border)'}`,
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
                    );
                  })}
                  {selectedIds.size > 0 && (
                    <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px' }}>
                      {selectedIds.size} selected · total {formatCantonAmount(formatDecimal(totalSelectedRaw))}
                    </div>
                  )}
                  <span className="field-hint">Click holdings to select (multiple allowed).</span>
                </div>
              )}
              {holdingsError && <p className="error-msg">{holdingsError}</p>}
            </section>

            <section className="card">
              <h2>Bridge to Plasma</h2>
              {!selectedIds.size ? (
                <p className="text-muted">Select one or more holdings on the left to withdraw.</p>
              ) : (
                <>
                  <div className="form-group">
                    <label>Amount to withdraw (mUSDC)</label>
                    <input
                      type="text"
                      className="input"
                      placeholder={formatDecimal(totalSelectedRaw)}
                      value={withdrawAmount}
                      onChange={(e) => { setWithdrawAmount(e.target.value); setWithdraw({ loading: false }); }}
                    />
                    <span className="field-hint">
                      Leave blank to withdraw the full selected amount ({formatCantonAmount(formatDecimal(totalSelectedRaw))}).
                      Enter less to do a partial withdrawal — the remainder stays as a new holding.
                    </span>
                    {withdrawAmount && !amountValid && (
                      <p className="error-msg" style={{ marginTop: '4px' }}>
                        Must be between 0 and {formatDecimal(totalSelectedRaw)}
                      </p>
                    )}
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
                    onClick={() => void handleWithdraw()}
                    disabled={withdraw.loading || !evmRecipient.trim() || !amountValid}
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
                onClick={() => void loadTxs(activeFp)}
                disabled={txLoading}
              >
                {txLoading ? 'Refreshing…' : 'Refresh'}
              </button>
            </div>
            <TxTable
              deposits={txs?.deposits ?? []}
              withdrawals={txs?.withdrawals ?? []}
              typeLabels={{ deposit: 'Receive', receive: 'Withdraw' }}
              emptyMessage="No transactions found for this account."
            />
          </section>
        </>
      )}
    </div>
  );
}
