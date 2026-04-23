import { DepositTx, WithdrawalTx } from '../lib/api';
import { TOKEN_DECIMALS } from '../lib/constants';

type UnifiedRow = {
  key: string;
  plasmaTxHash: string | undefined | null;
  cantonTxId: string | undefined | null;
  amount: string;
  isRawAmount: boolean;
  status: string;
  type: 'deposit' | 'receive';
};

function formatAmount(amount: string, isRaw: boolean): string {
  if (!isRaw) return `${amount} mUSDC`;
  try {
    const raw = BigInt(amount);
    const divisor = BigInt(10 ** TOKEN_DECIMALS);
    const whole = raw / divisor;
    const frac = (raw % divisor).toString().padStart(TOKEN_DECIMALS, '0');
    return `${whole}.${frac} mUSDC`;
  } catch {
    return `${amount}`;
  }
}

function shorten(val: string | undefined | null): string {
  if (!val) return '—';
  if (val.length <= 16) return val;
  return `${val.slice(0, 10)}…${val.slice(-6)}`;
}

function statusClass(status: string): string {
  const s = status.toLowerCase();
  if (s === 'relayed' || s === 'completed') return 'badge-success';
  if (s === 'failed') return 'badge-error';
  return 'badge-pending';
}

function statusLabel(status: string): string {
  const map: Record<string, string> = {
    relayed: 'Relayed',
    completed: 'Completed',
    failed: 'Failed',
    pending: 'Pending',
  };
  return map[status.toLowerCase()] ?? status;
}

type Props = {
  deposits: DepositTx[];
  withdrawals: WithdrawalTx[];
  emptyMessage?: string;
};

export function TxTable({ deposits, withdrawals, emptyMessage = 'No transactions' }: Props) {
  const rows: UnifiedRow[] = [
    ...deposits.map((d) => ({
      key: d.id,
      plasmaTxHash: d.transactionHash,
      cantonTxId: d.cantonTxId,
      amount: d.amount,
      isRawAmount: true,
      status: d.status,
      type: 'deposit' as const,
    })),
    ...withdrawals.map((w) => ({
      key: w.contractId,
      plasmaTxHash: w.evmTxHash,
      cantonTxId: w.contractId,
      amount: w.amount,
      isRawAmount: false,
      status: w.status,
      type: 'receive' as const,
    })),
  ];

  if (rows.length === 0) {
    return <div className="empty-state">{emptyMessage}</div>;
  }

  return (
    <div className="table-wrapper">
      <table className="tx-table">
        <thead>
          <tr>
            <th>Plasma Tx</th>
            <th>Canton Tx</th>
            <th>Amount</th>
            <th>Status</th>
            <th>Type</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              <td className="hash">
                <span title={row.plasmaTxHash ?? ''}>{shorten(row.plasmaTxHash)}</span>
              </td>
              <td className="hash">
                <span title={row.cantonTxId ?? ''}>{shorten(row.cantonTxId)}</span>
              </td>
              <td>{formatAmount(row.amount, row.isRawAmount)}</td>
              <td>
                <span className={`badge ${statusClass(row.status)}`}>
                  {statusLabel(row.status)}
                </span>
              </td>
              <td>
                <span className={`type-tag type-${row.type}`}>
                  {row.type === 'deposit' ? 'Deposit' : 'Receive'}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
