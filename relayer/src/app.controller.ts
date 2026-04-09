import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  BridgeTransaction,
  BridgeTxStatus,
} from './database/entities/bridge-transaction.entity';

@Controller()
export class AppController {
  constructor(
    private readonly config: ConfigService,
    @InjectRepository(BridgeTransaction)
    private readonly repo: Repository<BridgeTransaction>,
  ) {}

  @Get('health')
  async health() {
    const total = await this.repo.count();
    const pending = await this.repo.count({
      where: { status: BridgeTxStatus.PENDING },
    });
    const relayed = await this.repo.count({
      where: { status: BridgeTxStatus.RELAYED },
    });
    const failed = await this.repo.count({
      where: { status: BridgeTxStatus.FAILED },
    });

    return {
      status: 'ok',
      mode: this.config.get<string>('mode'),
      transactions: { total, pending, relayed, failed },
    };
  }
}
