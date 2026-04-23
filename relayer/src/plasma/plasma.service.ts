import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ethers } from 'ethers';

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
];

@Injectable()
export class PlasmaService implements OnModuleInit {
  private readonly logger = new Logger(PlasmaService.name);

  private provider: ethers.JsonRpcProvider;
  private defaultToken: string;
  private cantonBridgeAddress: string;

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    const rpc = this.config.get<string>('plasma.rpc');
    const token = this.config.get<string>('plasma.evmTokenAddress');
    const bridge = this.config.get<string>('plasma.cantonBridgeAddress');

    if (!rpc) throw new Error('plasma.rpc is not configured');
    if (!token) throw new Error('plasma.evmTokenAddress is not configured');
    if (!bridge) throw new Error('plasma.cantonBridgeAddress is not configured');

    this.provider = new ethers.JsonRpcProvider(rpc);
    this.defaultToken = token;
    this.cantonBridgeAddress = bridge;
    this.logger.log(`PlasmaService initialised → ${rpc}`);
  }

  async getBalance(address: string, token?: string): Promise<{ address: string; token: string; balance: string; decimals: number }> {
    const tokenAddr = token ?? this.defaultToken;
    const contract = new ethers.Contract(tokenAddr, ERC20_ABI, this.provider);
    const [balance, decimals] = await Promise.all([
      contract.balanceOf(address) as Promise<bigint>,
      contract.decimals() as Promise<bigint>,
    ]);
    return {
      address,
      token: tokenAddr,
      balance: balance.toString(),
      decimals: Number(decimals),
    };
  }

  async getTokenInfo(token?: string): Promise<{
    address: string;
    name: string;
    symbol: string;
    decimals: number;
    totalSupply: string;
    lockedInBridge: string;
  }> {
    const tokenAddr = token ?? this.defaultToken;
    const contract = new ethers.Contract(tokenAddr, ERC20_ABI, this.provider);
    const [name, symbol, decimals, totalSupply, lockedInBridge] = await Promise.all([
      contract.name() as Promise<string>,
      contract.symbol() as Promise<string>,
      contract.decimals() as Promise<bigint>,
      contract.totalSupply() as Promise<bigint>,
      contract.balanceOf(this.cantonBridgeAddress) as Promise<bigint>,
    ]);
    return {
      address: tokenAddr,
      name,
      symbol,
      decimals: Number(decimals),
      totalSupply: totalSupply.toString(),
      lockedInBridge: lockedInBridge.toString(),
    };
  }
}
