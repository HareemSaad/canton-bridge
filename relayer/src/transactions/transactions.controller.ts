import { Controller, Get, Query, BadRequestException } from '@nestjs/common';
import { ethers } from 'ethers';
import { TransactionsService } from './transactions.service';

function validateAddress(value: string, name: string): string {
  if (!ethers.isAddress(value)) throw new BadRequestException(`${name} is not a valid EVM address`);
  return value;
}

@Controller('transactions')
export class TransactionsController {
  constructor(private readonly txService: TransactionsService) {}

  /**
   * GET /transactions?depositor=0x...        — Plasma→Canton deposits sent by this EVM address
   * GET /transactions?fingerprint=<hex>      — Plasma→Canton deposits received by this fingerprint
   * GET /transactions?evmRecipient=0x...     — Canton→Plasma withdrawals targeting this EVM address
   *
   * Multiple params can be combined: e.g. depositor + evmRecipient returns both directions.
   */
  @Get()
  async getTransactions(
    @Query('depositor') depositor?: string,
    @Query('fingerprint') fingerprint?: string,
    @Query('evmRecipient') evmRecipient?: string,
  ) {
    if (!depositor && !fingerprint && !evmRecipient) {
      throw new BadRequestException(
        'Provide at least one of: depositor, fingerprint, evmRecipient',
      );
    }
    if (depositor) validateAddress(depositor, 'depositor');
    if (evmRecipient) validateAddress(evmRecipient, 'evmRecipient');
    return this.txService.getAll({ depositor, fingerprint, evmRecipient });
  }
}
