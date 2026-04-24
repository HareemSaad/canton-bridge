import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ethers } from 'ethers';

export interface FailedWithdrawalEvent {
  contractId: string;
  amount: string;
  evmRecipient: string;
  fingerprint: string;
  failReason: string;
}

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
export class WithdrawalRecoveryService implements OnModuleInit {
  private readonly logger = new Logger(WithdrawalRecoveryService.name);

  private cantonUrl: string;
  private partyId: string;
  private cantonToken: string | undefined;
  private userId: string;

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    const cantonUrl = this.config.get<string>('canton.url');
    const partyId = this.config.get<string>('canton.partyId');
    if (!cantonUrl) throw new Error('canton.url is not configured');
    if (!partyId) throw new Error('canton.partyId is not configured');

    this.cantonUrl = cantonUrl;
    this.partyId = partyId;
    this.cantonToken = this.config.get<string>('canton.token') || undefined;
    this.userId = this.config.get<string>('canton.userId') ?? 'sandbox';
  }

  /** List all DepositToPlasmaEvent contracts with DepositFailed status. */
  async getFailedEvents(): Promise<FailedWithdrawalEvent[]> {
    const items = await this.fetchActiveContracts();
    const failed: FailedWithdrawalEvent[] = [];

    for (const item of items) {
      const ev = item?.contractEntry?.JsActiveContract?.createdEvent;
      if (!ev?.templateId?.includes('DepositToPlasmaEvent')) continue;

      const args = ev.createArgument as {
        amount: string;
        evmRecipient: string;
        fingerprint: string;
        status: unknown;
      };

      const reason = this.extractFailReason(args.status);
      if (reason === null) continue;

      failed.push({
        contractId: ev.contractId,
        amount: args.amount,
        evmRecipient: args.evmRecipient,
        fingerprint: args.fingerprint,
        failReason: reason,
      });
    }

    return failed;
  }

  /**
   * Retry a failed event as-is — use this for transient failures (RPC error,
   * gas spike, etc.).  Resets status to DepositPending; the watcher picks it
   * up on its next poll cycle.
   */
  async retryEvent(contractId: string): Promise<void> {
    this.logger.log(`Retrying failed withdrawal contractId=${contractId}`);
    await this.submitCommand(
      {
        ExerciseCommand: {
          templateId: '#canton-bridge:Bridge.Contracts:DepositToPlasmaEvent',
          contractId,
          choice: 'Retry',
          choiceArgument: {},
        },
      },
      `recovery-retry-${contractId.slice(0, 16)}-${Date.now()}`,
    );
    this.logger.log(`Retried contractId=${contractId} — back to DepositPending`);
  }

  /**
   * Correct the evmRecipient and retry — use this when the original address
   * was wrong (e.g. a 32-byte fingerprint was pasted instead of a 20-byte
   * Ethereum address).  Resets status to DepositPending with the new address.
   */
  async correctAndRetry(contractId: string, newEvmRecipient: string): Promise<void> {
    if (!ethers.isAddress(newEvmRecipient)) {
      throw new Error(
        `Invalid EVM address: "${newEvmRecipient}". Must be a 20-byte 0x-prefixed hex address.`,
      );
    }
    this.logger.log(
      `Correcting evmRecipient for contractId=${contractId} → ${newEvmRecipient}`,
    );
    await this.submitCommand(
      {
        ExerciseCommand: {
          templateId: '#canton-bridge:Bridge.Contracts:DepositToPlasmaEvent',
          contractId,
          choice: 'CorrectAndRetry',
          choiceArgument: { newEvmRecipient },
        },
      },
      `recovery-correct-${contractId.slice(0, 16)}-${Date.now()}`,
    );
    this.logger.log(
      `Corrected contractId=${contractId} evmRecipient=${newEvmRecipient} — back to DepositPending`,
    );
  }

  // ─── Canton helpers ───────────────────────────────────────────────────────

  private async fetchActiveContracts(): Promise<ContractItem[]> {
    const endRes = await fetch(`${this.cantonUrl}/v2/state/ledger-end`, {
      headers: this.buildHeaders(),
    });
    if (!endRes.ok) throw new Error(`Failed to fetch ledger-end: ${endRes.status}`);
    const { offset } = (await endRes.json()) as { offset: string };

    const res = await fetch(`${this.cantonUrl}/v2/state/active-contracts`, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify({
        activeAtOffset: offset ?? '',
        filter: { filtersByParty: { [this.partyId]: {} } },
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Failed to query active contracts: ${res.status} ${text}`);
    }
    return (await res.json()) as ContractItem[];
  }

  private async submitCommand(
    command: Record<string, unknown>,
    commandId: string,
  ): Promise<void> {
    const res = await fetch(`${this.cantonUrl}/v2/commands/submit-and-wait`, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify({
        actAs: [this.partyId],
        userId: this.userId,
        commandId,
        commands: [command],
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Canton command failed ${res.status}: ${text}`);
    }
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.cantonToken) headers['Authorization'] = `Bearer ${this.cantonToken}`;
    return headers;
  }

  /**
   * Daml serialises variant types as objects: { tag: "DepositFailed", value: "reason" }
   * or { tag: "DepositPending" } etc.  Extract the fail reason if present.
   */
  private extractFailReason(status: unknown): string | null {
    if (!status || typeof status !== 'object') return null;
    const s = status as Record<string, unknown>;
    if (s['tag'] === 'DepositFailed') return (s['value'] as string) ?? 'unknown';
    // Some Daml JSON codecs nest it differently: { DepositFailed: "reason" }
    if ('DepositFailed' in s) return (s['DepositFailed'] as string) ?? 'unknown';
    return null;
  }
}
