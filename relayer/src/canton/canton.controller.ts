import { Controller, Get, Post, Query, Body, BadRequestException } from '@nestjs/common';
import { CantonQueryService } from './canton-query.service';
import { CantonService } from './canton.service';

@Controller('canton')
export class CantonController {
  constructor(
    private readonly cantonQuery: CantonQueryService,
    private readonly canton: CantonService,
  ) {}

  /**
   * GET /canton/balance?party=<partyId>  — lookup by full Canton party ID
   * GET /canton/balance?fingerprint=<hex> — lookup by EVM bytes32 fingerprint
   * Returns active CIP56Holdings for the user.
   */
  @Get('balance')
  async getBalance(
    @Query('party') party?: string,
    @Query('fingerprint') fingerprint?: string,
  ) {
    if (!party && !fingerprint) {
      throw new BadRequestException('Provide party or fingerprint query param');
    }
    const holdings = party
      ? await this.cantonQuery.getHoldingsByParty(party)
      : await this.cantonQuery.getHoldingsByFingerprint(fingerprint!);

    const totalAmount = holdings.reduce((acc, h) => {
      const [whole, frac = ''] = h.amount.split('.');
      return acc + BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, '0').slice(0, 6));
    }, 0n);

    return { holdings, totalRawAmount: totalAmount.toString() };
  }

  /**
   * GET /canton/stats
   * Returns aggregate token stats: total CIP56 supply, holding count,
   * withdrawal event counts, and pending deposit requests.
   */
  @Get('stats')
  async getStats() {
    return this.cantonQuery.getStats();
  }

  /**
   * POST /canton/withdraw
   * Creates a DepositToPlasma contract on Canton initiating a Canton→Plasma withdrawal.
   * Body: { fingerprint, holdingId, amount, evmRecipient }
   */
  @Post('withdraw')
  async createWithdrawal(
    @Body() body: { fingerprint?: string; holdingId?: string; amount?: string; evmRecipient?: string },
  ) {
    if (!body.fingerprint) throw new BadRequestException('fingerprint is required');
    if (!body.holdingId) throw new BadRequestException('holdingId is required');
    if (!body.amount) throw new BadRequestException('amount is required');
    if (!body.evmRecipient) throw new BadRequestException('evmRecipient is required');
    return this.canton.createWithdrawal({
      fingerprint: body.fingerprint,
      holdingId: body.holdingId,
      amount: body.amount,
      evmRecipient: body.evmRecipient,
    });
  }
}
