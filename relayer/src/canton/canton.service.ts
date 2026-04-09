import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BridgeTransaction } from '../database/entities/bridge-transaction.entity';
import {
  CantonSubmitRequest,
  CantonSubmitResponse,
} from './dto/canton-command.dto';

@Injectable()
export class CantonService implements OnModuleInit {
  private readonly logger = new Logger(CantonService.name);
  private baseUrl: string;
  private partyId: string;
  private token: string | undefined;
  private userId: string;
  private tokenDecimals: number;

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    const url = this.config.get<string>('canton.url');
    const partyId = this.config.get<string>('canton.partyId');

    if (!url) throw new Error('canton.url is not configured — check your .env');
    if (!partyId)
      throw new Error('canton.partyId is not configured — check your .env');

    this.baseUrl = url;
    this.partyId = partyId;
    this.token = this.config.get<string>('canton.token') || undefined;
    this.userId = this.config.get<string>('canton.userId') ?? 'sandbox';
    this.tokenDecimals = this.config.get<number>('canton.tokenDecimals') ?? 6;

    this.logger.log(`Canton client initialised → ${this.baseUrl}`);
    this.logger.log(`Acting as party: ${this.partyId}`);
  }

  /**
   * Submit a CreateAndExercise(BridgeReceiver → Mint) command to Canton.
   * Returns the MockUSDCxHolding contract ID on success.
   * The `tx.recipient` field (written by the user on the Plasma side) is used
   * directly as the Canton party ID — no mapping required.
   */
  async relay(tx: BridgeTransaction): Promise<string> {
    const body: CantonSubmitRequest = {
      actAs: [this.partyId],
      userId: this.userId,
      commandId: `bridge-nonce-${tx.nonce}`,
      commands: [
        {
          CreateAndExerciseCommand: {
            templateId: '#canton-bridge:BridgeReceiver:BridgeReceiver',
            createArguments: {
              bridgeOperator: this.partyId,
              recipient: tx.recipient,
              plasmaToken: tx.token,
              plasmaTxHash: tx.transactionHash,
              nonce: parseInt(tx.nonce, 10),
              amount: this.toCantonDecimal(tx.amount, this.tokenDecimals),
            },
            choice: 'Mint',
            choiceArgument: {},
          },
        },
      ],
    };

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    const res = await fetch(`${this.baseUrl}/v2/commands/submit-and-wait`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Canton responded ${res.status}: ${text}`);
    }

    const data = (await res.json()) as CantonSubmitResponse;
    return data.updateId;
  }

  /**
   * Convert raw uint256 token units to a Daml Decimal string.
   * e.g. "1000000" with decimals=6 → "1.000000"
   * Uses BigInt arithmetic to avoid float precision loss on large amounts.
   */
  private toCantonDecimal(rawAmount: string, decimals: number): string {
    const raw = BigInt(rawAmount);
    const divisor = BigInt(10 ** decimals);
    const whole = raw / divisor;
    const remainder = raw % divisor;
    return `${whole}.${remainder.toString().padStart(decimals, '0')}`;
  }
}
