import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  BadRequestException,
  NotFoundException,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { WithdrawalRecoveryService } from './withdrawal-recovery.service';

@Controller('admin/recovery')
export class WithdrawalRecoveryController {
  private readonly logger = new Logger(WithdrawalRecoveryController.name);

  constructor(private readonly recovery: WithdrawalRecoveryService) {}

  /**
   * GET /admin/recovery/failed
   * Returns all DepositToPlasmaEvent contracts currently in DepositFailed state.
   */
  @Get('failed')
  async listFailed() {
    try {
      const events = await this.recovery.getFailedEvents();
      return { count: events.length, events };
    } catch (err) {
      this.logger.error('Failed to list failed events', (err as Error).message);
      throw new InternalServerErrorException((err as Error).message);
    }
  }

  /**
   * POST /admin/recovery/:contractId/retry
   * Resets a failed withdrawal event back to DepositPending as-is.
   * Use when the failure was transient (network, gas, RPC timeout, etc.).
   * The withdrawal watcher will pick it up on the next poll cycle (~30s).
   */
  @Post(':contractId/retry')
  async retry(@Param('contractId') contractId: string) {
    if (!contractId?.trim()) throw new BadRequestException('contractId is required');
    try {
      await this.recovery.retryEvent(contractId.trim());
      return {
        ok: true,
        message: 'Event reset to DepositPending — relayer will retry on next poll',
        contractId: contractId.trim(),
      };
    } catch (err) {
      const msg = (err as Error).message ?? '';
      if (msg.includes('CONTRACT_NOT_FOUND') || msg.includes('not found')) {
        throw new NotFoundException(`Contract ${contractId} not found or not in DepositFailed state`);
      }
      this.logger.error(`Retry failed for ${contractId}`, msg);
      throw new InternalServerErrorException(msg);
    }
  }

  /**
   * POST /admin/recovery/:contractId/correct
   * Corrects the evmRecipient and resets to DepositPending.
   * Use when the user submitted a wrong address (e.g. pasted their fingerprint
   * instead of an Ethereum wallet address).
   * Body: { evmRecipient: string }  — must be a valid 20-byte 0x address.
   */
  @Post(':contractId/correct')
  async correct(
    @Param('contractId') contractId: string,
    @Body() body: { evmRecipient?: string },
  ) {
    if (!contractId?.trim()) throw new BadRequestException('contractId is required');
    if (!body.evmRecipient?.trim()) throw new BadRequestException('evmRecipient is required');

    try {
      await this.recovery.correctAndRetry(contractId.trim(), body.evmRecipient.trim());
      return {
        ok: true,
        message: 'evmRecipient corrected, event reset to DepositPending — relayer will retry on next poll',
        contractId: contractId.trim(),
        newEvmRecipient: body.evmRecipient.trim(),
      };
    } catch (err) {
      const msg = (err as Error).message ?? '';
      if (msg.startsWith('Invalid EVM address')) throw new BadRequestException(msg);
      if (msg.includes('CONTRACT_NOT_FOUND') || msg.includes('not found')) {
        throw new NotFoundException(`Contract ${contractId} not found or not in DepositFailed state`);
      }
      this.logger.error(`Correct-and-retry failed for ${contractId}`, msg);
      throw new InternalServerErrorException(msg);
    }
  }
}
