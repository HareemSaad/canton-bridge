import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import configuration from './config/configuration';
import { DatabaseModule } from './database/database.module';
import { BridgeTransaction } from './database/entities/bridge-transaction.entity';
import { WatcherModule } from './watcher/watcher.module';
import { SubgraphModule } from './subgraph/subgraph.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    DatabaseModule,
    TypeOrmModule.forFeature([BridgeTransaction]),
    SubgraphModule,
    WatcherModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
