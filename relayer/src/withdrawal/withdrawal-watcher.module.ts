import { Module } from '@nestjs/common';
import { WithdrawalWatcherService } from './withdrawal-watcher.service';

@Module({
  providers: [WithdrawalWatcherService],
})
export class WithdrawalWatcherModule {}
