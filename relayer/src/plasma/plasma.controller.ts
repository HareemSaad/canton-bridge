import { Controller, Get, Post, Query, BadRequestException } from '@nestjs/common';
import { ethers } from 'ethers';
import { PlasmaService } from './plasma.service';

function requireAddress(value: string | undefined, name: string): string {
  if (!value) throw new BadRequestException(`${name} query param is required`);
  if (!ethers.isAddress(value)) throw new BadRequestException(`${name} is not a valid EVM address`);
  return value;
}

function optionalAddress(value: string | undefined, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (!ethers.isAddress(value)) throw new BadRequestException(`${name} is not a valid EVM address`);
  return value;
}

@Controller('plasma')
export class PlasmaController {
  constructor(private readonly plasma: PlasmaService) {}

  /**
   * GET /plasma/balance?address=0x...&token=0x... (token optional, defaults to configured ERC20)
   * Returns the raw token balance and decimals for an EVM address.
   */
  @Get('balance')
  async getBalance(
    @Query('address') address: string,
    @Query('token') token?: string,
  ) {
    const addr = requireAddress(address, 'address');
    const tok = optionalAddress(token, 'token');
    return this.plasma.getBalance(addr, tok);
  }

  /**
   * POST /plasma/faucet?address=0x...
   * Mints 1,000 test tokens (mUSDC) to the given address using the deployer wallet.
   */
  @Post('faucet')
  async faucet(@Query('address') address: string) {
    const addr = requireAddress(address, 'address');
    return this.plasma.faucet(addr);
  }

  /**
   * GET /plasma/token?token=0x... (token optional, defaults to configured ERC20)
   * Returns ERC20 metadata, total supply, and amount locked in the bridge escrow.
   */
  @Get('token')
  async getTokenInfo(@Query('token') token?: string) {
    const tok = optionalAddress(token, 'token');
    return this.plasma.getTokenInfo(tok);
  }
}
