import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

type ContractItem = {
  contractEntry?: {
    JsActiveContract?: {
      createdEvent: {
        contractId: string;
        templateId: string;
        createArgument: Record<string, unknown>;
      };
    };
  };
};

@Injectable()
export class CantonQueryService implements OnModuleInit {
  private readonly logger = new Logger(CantonQueryService.name);

  private baseUrl: string;
  private partyId: string;
  private token: string | undefined;

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    const url = this.config.get<string>('canton.url');
    const partyId = this.config.get<string>('canton.partyId');
    if (!url) throw new Error('canton.url is not configured');
    if (!partyId) throw new Error('canton.partyId is not configured');
    this.baseUrl = url;
    this.partyId = partyId;
    this.token = this.config.get<string>('canton.token') || undefined;
  }

  async getHoldingsByFingerprint(fingerprint: string): Promise<HoldingInfo[]> {
    const hex = fingerprint.startsWith('0x') ? fingerprint.slice(2).toLowerCase() : fingerprint.toLowerCase();
    const items = await this.fetchActiveContracts();
    const holdings: HoldingInfo[] = [];

    for (const item of items) {
      const event = item?.contractEntry?.JsActiveContract?.createdEvent;
      if (!event?.templateId?.includes('CIP56Holding')) continue;
      const args = event.createArgument as {
        owner: string;
        amount: string;
        instrumentId: string;
        metadata: Record<string, string>;
      };
      // Match on EVM fingerprint stored in metadata (set at mint time)
      const evmFp = (args.metadata?.['bridge.userFingerprint'] ?? '').toLowerCase();
      // Also match on the Canton party hash suffix (the part after '::' in the party ID)
      const partyHash = (args.owner?.split('::')[1] ?? '').toLowerCase();
      if (evmFp !== hex && partyHash !== hex) continue;
      holdings.push({
        contractId: event.contractId,
        owner: args.owner,
        amount: args.amount,
        token: args.instrumentId,
      });
    }
    return holdings;
  }

  async getHoldingsByParty(partyId: string): Promise<HoldingInfo[]> {
    const items = await this.fetchActiveContracts();
    const holdings: HoldingInfo[] = [];

    for (const item of items) {
      const event = item?.contractEntry?.JsActiveContract?.createdEvent;
      if (!event?.templateId?.includes('CIP56Holding')) continue;
      const args = event.createArgument as { owner: string; amount: string; instrumentId: string };
      if (args.owner === partyId) {
        holdings.push({
          contractId: event.contractId,
          owner: args.owner,
          amount: args.amount,
          token: args.instrumentId,
        });
      }
    }
    return holdings;
  }

  async getStats(): Promise<CantonStats> {
    const items = await this.fetchActiveContracts();

    let totalSupplyRaw = 0n;
    let holdingCount = 0;
    let pendingWithdrawals = 0;
    let completedWithdrawals = 0;
    let failedWithdrawals = 0;
    let pendingDeposits = 0;

    for (const item of items) {
      const event = item?.contractEntry?.JsActiveContract?.createdEvent;
      if (!event) continue;
      const templateId = event.templateId ?? '';
      const argsJson = JSON.stringify(event.createArgument);

      if (templateId.includes('CIP56Holding')) {
        holdingCount++;
        const amount = (event.createArgument as { amount: string }).amount ?? '0';
        const parsed = this.parseDecimal(amount);
        totalSupplyRaw += parsed;
      } else if (templateId.includes('DepositToPlasmaEvent')) {
        if (argsJson.includes('DepositPending')) pendingWithdrawals++;
        else if (argsJson.includes('DepositCompleted')) completedWithdrawals++;
        else if (argsJson.includes('DepositFailed')) failedWithdrawals++;
      } else if (templateId.includes('DepositToPlasma') && !templateId.includes('DepositToPlasmaEvent')) {
        pendingDeposits++;
      }
    }

    return {
      totalSupplyRaw: totalSupplyRaw.toString(),
      holdingCount,
      withdrawals: {
        pending: pendingWithdrawals,
        completed: completedWithdrawals,
        failed: failedWithdrawals,
      },
      pendingDepositRequests: pendingDeposits,
    };
  }

  async getWithdrawalEvents(evmRecipient?: string): Promise<WithdrawalEventInfo[]> {
    const items = await this.fetchActiveContracts();
    const events: WithdrawalEventInfo[] = [];

    for (const item of items) {
      const event = item?.contractEntry?.JsActiveContract?.createdEvent;
      if (!event?.templateId?.includes('DepositToPlasmaEvent')) continue;
      const args = event.createArgument as {
        amount: string;
        evmRecipient: string;
        fingerprint: string;
        status: unknown;
        user: string;
      };
      if (evmRecipient && args.evmRecipient?.toLowerCase() !== evmRecipient.toLowerCase()) continue;
      const statusJson = JSON.stringify(args.status);
      let status: 'pending' | 'completed' | 'failed' = 'pending';
      let evmTxHash: string | undefined;
      if (statusJson.includes('DepositCompleted')) {
        status = 'completed';
        const statusObj = args.status as { tag?: string; value?: string } | string;
        if (typeof statusObj === 'object' && statusObj !== null && 'value' in statusObj) {
          evmTxHash = statusObj.value;
        }
      } else if (statusJson.includes('DepositFailed')) {
        status = 'failed';
      }
      events.push({
        contractId: event.contractId,
        user: args.user,
        amount: args.amount,
        evmRecipient: args.evmRecipient,
        fingerprint: args.fingerprint,
        status,
        evmTxHash,
      });
    }
    return events;
  }

  // ─── helpers ─────────────────────────────────────────────────────────────────

  async fetchActiveContracts(): Promise<ContractItem[]> {
    const endRes = await fetch(`${this.baseUrl}/v2/state/ledger-end`, {
      headers: this.buildHeaders(),
    });
    if (!endRes.ok) throw new Error(`Failed to fetch ledger-end: ${endRes.status}`);
    const endData = (await endRes.json()) as { offset: string };

    const res = await fetch(`${this.baseUrl}/v2/state/active-contracts`, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify({
        activeAtOffset: endData.offset ?? '',
        filter: { filtersByParty: { [this.partyId]: {} } },
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Failed to query active contracts: ${res.status} ${text}`);
    }
    return (await res.json()) as ContractItem[];
  }

  private buildHeaders(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.token) h['Authorization'] = `Bearer ${this.token}`;
    return h;
  }

  private parseDecimal(s: string): bigint {
    const [whole, frac = ''] = s.split('.');
    const fracPadded = frac.padEnd(10, '0').slice(0, 10);
    return BigInt(whole) * BigInt(10 ** 10) + BigInt(fracPadded);
  }
}

export type HoldingInfo = {
  contractId: string;
  owner: string;
  amount: string;
  token: string;
};

export type CantonStats = {
  totalSupplyRaw: string;
  holdingCount: number;
  withdrawals: { pending: number; completed: number; failed: number };
  pendingDepositRequests: number;
};

export type WithdrawalEventInfo = {
  contractId: string;
  user: string;
  amount: string;
  evmRecipient: string;
  fingerprint: string;
  status: 'pending' | 'completed' | 'failed';
  evmTxHash?: string;
};
