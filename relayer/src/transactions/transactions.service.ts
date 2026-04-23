import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BridgeTransaction } from '../database/entities/bridge-transaction.entity';
import { CantonQueryService, WithdrawalEventInfo } from '../canton/canton-query.service';

export type DepositTx = {
  id: string;
  direction: 'plasma_to_canton';
  nonce: string;
  token: string;
  amount: string;
  depositor: string | null;
  recipient: string;
  transactionHash: string;
  blockNumber: string;
  blockTimestamp: string;
  status: string;
  cantonTxId: string | null;
  createdAt: Date;
};

export type WithdrawalTx = WithdrawalEventInfo & { direction: 'canton_to_plasma' };

@Injectable()
export class TransactionsService {
  constructor(
    @InjectRepository(BridgeTransaction)
    private readonly repo: Repository<BridgeTransaction>,
    private readonly cantonQuery: CantonQueryService,
  ) {}

  async getByDepositor(depositor: string): Promise<DepositTx[]> {
    const rows = await this.repo.find({
      where: { depositor: depositor.toLowerCase() },
      order: { createdAt: 'DESC' },
    });
    return rows.map(this.toDepositTx);
  }

  async getByFingerprint(fingerprint: string): Promise<DepositTx[]> {
    const hex = fingerprint.startsWith('0x') ? fingerprint.slice(2).toLowerCase() : fingerprint.toLowerCase();
    const rows = await this.repo
      .createQueryBuilder('bt')
      .where('LOWER(bt.recipient) = :hex', { hex })
      .orderBy('bt.created_at', 'DESC')
      .getMany();
    return rows.map(this.toDepositTx);
  }

  async getWithdrawalsByEvmRecipient(evmRecipient: string): Promise<WithdrawalTx[]> {
    const events = await this.cantonQuery.getWithdrawalEvents(evmRecipient);
    return events.map((e) => ({ ...e, direction: 'canton_to_plasma' as const }));
  }

  async getWithdrawalsByFingerprint(fingerprint: string): Promise<WithdrawalTx[]> {
    const events = await this.cantonQuery.getWithdrawalEvents(undefined, fingerprint);
    return events.map((e) => ({ ...e, direction: 'canton_to_plasma' as const }));
  }

  async getAll(params: {
    depositor?: string;
    fingerprint?: string;
    evmRecipient?: string;
  }): Promise<{ deposits: DepositTx[]; withdrawals: WithdrawalTx[] }> {
    const [deposits, withdrawals] = await Promise.all([
      params.depositor
        ? this.getByDepositor(params.depositor)
        : params.fingerprint
          ? this.getByFingerprint(params.fingerprint)
          : Promise.resolve([]),
      params.evmRecipient
        ? this.getWithdrawalsByEvmRecipient(params.evmRecipient)
        : params.fingerprint
          ? this.getWithdrawalsByFingerprint(params.fingerprint)
          : Promise.resolve([]),
    ]);
    return { deposits, withdrawals };
  }

  private toDepositTx(tx: BridgeTransaction): DepositTx {
    return {
      id: tx.id,
      direction: 'plasma_to_canton',
      nonce: tx.nonce,
      token: tx.token,
      amount: tx.amount,
      depositor: tx.depositor,
      recipient: tx.recipient,
      transactionHash: tx.transactionHash,
      blockNumber: tx.blockNumber,
      blockTimestamp: tx.blockTimestamp,
      status: tx.status,
      cantonTxId: tx.cantonTxId,
      createdAt: tx.createdAt,
    };
  }
}
