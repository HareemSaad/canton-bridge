import { Controller, Get, Query, BadRequestException } from '@nestjs/common';
import { CantonQueryService } from './canton-query.service';

@Controller('canton')
export class CantonController {
  constructor(private readonly cantonQuery: CantonQueryService) {}

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
}
