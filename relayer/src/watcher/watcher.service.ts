import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  BridgeTransaction,
  BridgeTxStatus,
} from '../database/entities/bridge-transaction.entity';
import { SubgraphService } from '../subgraph/subgraph.service';

@Injectable()
export class WatcherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WatcherService.name);
  private pollTimer: NodeJS.Timeout | null = null;
  private pendingCheckTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly subgraph: SubgraphService,
    private readonly config: ConfigService,
    @InjectRepository(BridgeTransaction)
    private readonly repo: Repository<BridgeTransaction>,
  ) {}

  onModuleInit() {
    const pollMs = this.config.get<number>('subgraph.pollIntervalMs') ?? 30_000;
    const pendingMs =
      this.config.get<number>('canton.pendingCheckIntervalMs') ?? 60_000;

    this.logger.log(`Starting subgraph poller (every ${pollMs}ms)`);
    this.logger.log(`Starting pending-check job (every ${pendingMs}ms)`);

    // Run immediately on startup, then on interval
    void this.pollSubgraph();
    this.pollTimer = setInterval(() => void this.pollSubgraph(), pollMs);

    void this.checkPending();
    this.pendingCheckTimer = setInterval(
      () => void this.checkPending(),
      pendingMs,
    );
  }

  onModuleDestroy() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.pendingCheckTimer) clearInterval(this.pendingCheckTimer);
  }

  private async pollSubgraph(): Promise<void> {
    try {
      const pageSize = this.config.get<number>('subgraph.pageSize') ?? 100;
      let cursor = await this.getLastNonce();
      let totalInserted = 0;

      // Drain any burst: keep fetching full pages until a partial page is returned
      while (true) {
        const locks = await this.subgraph.fetchLocksSinceNonce(
          cursor,
          pageSize,
        );

        if (locks.length === 0) break;

        const rows = locks.map((l) => ({
          nonce: l.nonce,
          token: l.token,
          amount: l.amount,
          recipient: l.recipient,
          toChain: l.toChain,
          blockNumber: l.blockNumber,
          blockTimestamp: l.blockTimestamp,
          transactionHash: l.transactionHash,
          status: BridgeTxStatus.PENDING,
          cantonTxId: null,
          cantonSubmittedAt: null,
        }));

        const result = await this.repo
          .createQueryBuilder()
          .insert()
          .into(BridgeTransaction)
          .values(rows)
          .orIgnore()
          .execute();

        totalInserted += result.raw?.length ?? 0;
        cursor = locks[locks.length - 1].nonce;

        if (locks.length < pageSize) break;
      }

      if (totalInserted > 0) {
        this.logger.log(
          `Inserted ${totalInserted} new lock(s), latest nonce: ${cursor}`,
        );
      }
    } catch (err) {
      this.logger.error('Subgraph poll failed', (err as Error).message);
    }
  }

  private async checkPending(): Promise<void> {
    try {
      const pending = await this.repo.find({
        where: { status: BridgeTxStatus.PENDING },
        take: 50,
        order: { nonce: 'ASC' },
      });

      if (pending.length === 0) return;

      this.logger.log(
        `${pending.length} pending transaction(s) awaiting Canton submission`,
      );

      for (const tx of pending) {
        // Canton submission not implemented yet — placeholder for future CantonModule
        this.logger.debug(
          `[PENDING] nonce=${tx.nonce} token=${tx.token} amount=${tx.amount} recipient=${tx.recipient}`,
        );
      }
    } catch (err) {
      this.logger.error('Pending check failed', (err as Error).message);
    }
  }

  private async getLastNonce(): Promise<string> {
    const result = await this.repo
      .createQueryBuilder('b')
      .select('MAX(b.nonce)', 'maxNonce')
      .getRawOne<{ maxNonce: string | null }>();

    return result?.maxNonce ?? '-1';
  }
}
