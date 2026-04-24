import { Module } from '@nestjs/common';
import { WithdrawalRecoveryService } from './withdrawal-recovery.service';
import { WithdrawalRecoveryController } from './withdrawal-recovery.controller';

@Module({
  providers: [WithdrawalRecoveryService],
  controllers: [WithdrawalRecoveryController],
})
export class WithdrawalRecoveryModule {}
