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
  private tokenConfigId: string;
  private bridgeStateId: string;

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    const url = this.config.get<string>('canton.url');
    const partyId = this.config.get<string>('canton.partyId');
    const tokenConfigId = this.config.get<string>('canton.tokenConfigId');
    const bridgeStateId = this.config.get<string>('canton.bridgeStateId');

    if (!url) throw new Error('canton.url is not configured');
    if (!partyId) throw new Error('canton.partyId is not configured');
    if (!tokenConfigId)
      throw new Error(
        'canton.tokenConfigId is not configured — check LOCAL_TOKEN_CONFIG_ID in .env',
      );
    if (!bridgeStateId)
      throw new Error(
        'canton.bridgeStateId is not configured — check LOCAL_BRIDGE_STATE_ID in .env',
      );

    this.baseUrl = url;
    this.partyId = partyId;
    this.token = this.config.get<string>('canton.token') || undefined;
    this.userId = this.config.get<string>('canton.userId') ?? 'sandbox';
    this.tokenDecimals = this.config.get<number>('canton.tokenDecimals') ?? 6;
    this.tokenConfigId = tokenConfigId;
    this.bridgeStateId = bridgeStateId;

    this.logger.log(`Canton client initialised → ${this.baseUrl}`);
    this.logger.log(`Acting as party: ${this.partyId}`);
    this.logger.log(`TokenConfig: ${this.tokenConfigId}`);
    this.logger.log(`BridgeState: ${this.bridgeStateId}`);
  }

  /**
   * Relay a validated deposit to Canton using the CIP-56 MintCommand flow.
   *
   * Flow:
   *   1. Resolve the recipient Canton party from the EVM fingerprint via
   *      the FingerprintMapping active contract store.
   *   2. Submit CreateAndExercise(MintCommand → Execute) which atomically:
   *        a. Records the tx hash in BridgeState (replay guard)
   *        b. Calls TokenConfig.IssuerMint → creates CIP56Holding + audit event
   *
   * Returns the Canton updateId on success.
   */
  async relay(tx: BridgeTransaction): Promise<string> {
    // 1. Resolve fingerprint → Canton party ID
    const recipient = await this.resolveFingerprint(tx.recipient);

    // 2. Strip "0x" prefix from fingerprint for Daml Text storage
    const fingerprintHex = tx.recipient.startsWith('0x')
      ? tx.recipient.slice(2)
      : tx.recipient;

    const body: CantonSubmitRequest = {
      actAs: [this.partyId],
      userId: this.userId,
      commandId: `bridge-tx-${tx.transactionHash}-${tx.nonce}`,
      commands: [
        {
          CreateAndExerciseCommand: {
            templateId: '#canton-bridge:Bridge.Contracts:MintCommand',
            createArguments: {
              issuer: this.partyId,
              recipient,
              amount: this.toCantonDecimal(tx.amount, this.tokenDecimals),
              txHash: tx.transactionHash,
              fingerprint: fingerprintHex,
              chainRef: 'plasma',
              tokenConfigId: this.tokenConfigId,
              bridgeStateId: this.bridgeStateId,
            },
            choice: 'Execute',
            choiceArgument: { dummy: {} },
          },
        },
      ],
    };

    const res = await fetch(`${this.baseUrl}/v2/commands/submit-and-wait`, {
      method: 'POST',
      headers: this.buildHeaders(),
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
   * Resolve an EVM bytes32 fingerprint to a Canton party ID by querying
   * the active FingerprintMapping contracts.
   *
   * The fingerprint stored in `tx.recipient` is the bytes32 hex value from the
   * DepositToCanton event (with or without 0x prefix).
   */
  async resolveFingerprint(fingerprint: string): Promise<string> {
    const hex = fingerprint.startsWith('0x')
      ? fingerprint.slice(2).toLowerCase()
      : fingerprint.toLowerCase();

    // Fetch current ledger offset (required by the active-contracts endpoint)
    const endRes = await fetch(`${this.baseUrl}/v2/state/ledger-end`, {
      headers: this.buildHeaders(),
    });
    if (!endRes.ok) {
      throw new Error(`Failed to fetch ledger-end: ${endRes.status}`);
    }
    const endData = (await endRes.json()) as { offset: string };
    const activeAtOffset = endData.offset ?? '';

    // Query ALL active contracts visible to the bridge operator (no template
    // filter — simpler than fighting the v2 filter schema) then filter in code.
    const res = await fetch(`${this.baseUrl}/v2/state/active-contracts`, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify({
        activeAtOffset,
        filter: {
          filtersByParty: {
            [this.partyId]: {},
          },
        },
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `Failed to query active contracts: ${res.status} ${text}`,
      );
    }

    // Response is a JSON array:
    // [{ contractEntry: { JsActiveContract: { createdEvent: { templateId, createArgument } } } }]
    type ContractItem = {
      contractEntry?: {
        JsActiveContract?: {
          createdEvent: {
            templateId: string;
            createArgument: { fingerprint: string; userParty: string };
          };
        };
      };
    };
    const items = (await res.json()) as ContractItem[];

    const match = items.find((item) => {
      const event = item?.contractEntry?.JsActiveContract?.createdEvent;
      if (!event?.templateId?.includes('FingerprintMapping')) return false;
      return event.createArgument?.fingerprint?.toLowerCase() === hex;
    });

    if (!match) {
      throw new Error(
        `No FingerprintMapping found for fingerprint: ${hex}. ` +
          `Register the user via FingerprintMapping.create before depositing.`,
      );
    }

    return match!.contractEntry!.JsActiveContract!.createdEvent.createArgument.userParty;
  }

  // ─── helpers ──────────────────────────────────────────────────────────────

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }
    return headers;
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
