import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CantonModule } from '../canton/canton.module';
import { BridgeTransaction } from '../database/entities/bridge-transaction.entity';
import { SubgraphModule } from '../subgraph/subgraph.module';
import { WatcherService } from './watcher.service';

@Module({
  imports: [
    SubgraphModule,
    CantonModule,
    TypeOrmModule.forFeature([BridgeTransaction]),
  ],
  providers: [WatcherService],
})
export class WatcherModule {}
