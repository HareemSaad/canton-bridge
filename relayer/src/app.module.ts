import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { CantonModule } from './canton/canton.module';
import configuration from './config/configuration';
import { DatabaseModule } from './database/database.module';
import { BridgeTransaction } from './database/entities/bridge-transaction.entity';
import { WatcherModule } from './watcher/watcher.module';
import { SubgraphModule } from './subgraph/subgraph.module';
import { WithdrawalWatcherModule } from './withdrawal/withdrawal-watcher.module';
import { PlasmaModule } from './plasma/plasma.module';
import { TransactionsModule } from './transactions/transactions.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    DatabaseModule,
    TypeOrmModule.forFeature([BridgeTransaction]),
    SubgraphModule,
    CantonModule,
    WatcherModule,
    WithdrawalWatcherModule,
    PlasmaModule,
    TransactionsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
