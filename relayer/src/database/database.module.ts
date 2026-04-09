import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BridgeTransaction } from './entities/bridge-transaction.entity';

@Global()
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        url: config.get<string>('database.url'),
        entities: [BridgeTransaction],
        synchronize: config.get<string>('nodeEnv') === 'development',
        logging: config.get<string>('nodeEnv') === 'development',
      }),
    }),
    TypeOrmModule.forFeature([BridgeTransaction]),
  ],
  exports: [TypeOrmModule],
})
export class DatabaseModule {}
