import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ethers } from 'ethers';
import { BridgeTransaction } from '../database/entities/bridge-transaction.entity';
import {
  CantonSubmitRequest,
  CantonSubmitResponse,
} from './dto/canton-command.dto';

type ContractItem = {
  contractEntry?: {
    JsActiveContract?: {
      createdEvent: {
        contractId: string;
        templateId: string;
        createArgument: Record<string, unknown>;
      };
    };
  };
};

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
   *   1. Single active-contracts query resolves both:
   *        a. FingerprintMapping → recipient Canton party ID
   *        b. Current BridgeState contract ID (changes after every RecordMint)
   *   2. Submit CreateAndExercise(MintCommand → Execute) which atomically:
   *        a. Records the tx hash in BridgeState (replay guard)
   *        b. Calls TokenConfig.IssuerMint → creates CIP56Holding + audit event
   *
   * Returns the Canton updateId on success.
   */
  async relay(tx: BridgeTransaction): Promise<string> {
    // Strip "0x" prefix — Daml stores fingerprint as plain hex Text
    const fingerprintHex = tx.recipient.startsWith('0x')
      ? tx.recipient.slice(2).toLowerCase()
      : tx.recipient.toLowerCase();

    // Single active-contracts call: resolve fingerprint → party AND current BridgeState ID.
    // BridgeState.RecordMint is a consuming choice, so its contract ID changes after
    // every successful relay. We must fetch it fresh each time.
    const { recipient, bridgeStateId } = await this.resolveForRelay(fingerprintHex);

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
              bridgeStateId,
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
   * Single active-contracts fetch that returns both the recipient party ID
   * (from FingerprintMapping) and the current live BridgeState contract ID.
   *
   * BridgeState.RecordMint is consuming — its contract ID changes after every
   * successful relay, so it must be fetched fresh on each call rather than
   * read once at startup.
   */
  private async resolveForRelay(
    fingerprintHex: string,
  ): Promise<{ recipient: string; bridgeStateId: string }> {
    const endRes = await fetch(`${this.baseUrl}/v2/state/ledger-end`, {
      headers: this.buildHeaders(),
    });
    if (!endRes.ok)
      throw new Error(`Failed to fetch ledger-end: ${endRes.status}`);
    const { offset } = (await endRes.json()) as { offset: string };

    const res = await fetch(`${this.baseUrl}/v2/state/active-contracts`, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify({
        activeAtOffset: offset ?? '',
        filter: { filtersByParty: { [this.partyId]: {} } },
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Failed to query active contracts: ${res.status} ${text}`);
    }

    const items = (await res.json()) as ContractItem[];

    let recipient: string | undefined;
    let bridgeStateId: string | undefined;

    for (const item of items) {
      const ev = item?.contractEntry?.JsActiveContract?.createdEvent;
      if (!ev) continue;
      if (ev.templateId.includes('FingerprintMapping')) {
        const args = ev.createArgument as { fingerprint: string; userParty: string };
        if ((args.fingerprint ?? '').toLowerCase() === fingerprintHex) {
          recipient = args.userParty;
        }
      }
      if (ev.templateId.includes('BridgeState')) {
        bridgeStateId = ev.contractId;
      }
      if (recipient && bridgeStateId) break;
    }

    if (!recipient)
      throw new Error(
        `No FingerprintMapping found for fingerprint: ${fingerprintHex}. ` +
          `Register the user via FingerprintMapping.create before depositing.`,
      );
    if (!bridgeStateId)
      throw new Error('No active BridgeState contract found on the ledger');

    this.logger.debug(`BridgeState resolved: ${bridgeStateId}`);
    return { recipient, bridgeStateId };
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

    const items = (await res.json()) as ContractItem[];

    const match = items.find((item) => {
      const event = item?.contractEntry?.JsActiveContract?.createdEvent;
      if (!event?.templateId?.includes('FingerprintMapping')) return false;
      const args = event.createArgument as { fingerprint: string; userParty: string };
      return args.fingerprint?.toLowerCase() === hex;
    });

    if (!match) {
      throw new Error(
        `No FingerprintMapping found for fingerprint: ${hex}. ` +
          `Register the user via FingerprintMapping.create before depositing.`,
      );
    }

    const args = match!.contractEntry!.JsActiveContract!.createdEvent.createArgument as { userParty: string };
    return args.userParty;
  }

  /**
   * Create a DepositToPlasma contract on the Canton ledger on behalf of the user.
   * The relayer acts as the user party (sandbox userId has all-party rights).
   * The WithdrawalWatcherService will pick this up within one poll cycle.
   */
  async createWithdrawal(params: {
    fingerprint: string;
    holdingId: string;
    amount: string;
    evmRecipient: string;
  }): Promise<{ updateId: string }> {
    const fingerprintHex = params.fingerprint.startsWith('0x')
      ? params.fingerprint.slice(2).toLowerCase()
      : params.fingerprint.toLowerCase();

    const userParty = await this.resolveFingerprint(params.fingerprint);

    const body = {
      actAs: [userParty],
      userId: this.userId,
      commandId: `withdraw-${Date.now()}-${fingerprintHex.slice(0, 8)}`,
      commands: [
        {
          CreateCommand: {
            templateId: '#canton-bridge:Bridge.Contracts:DepositToPlasma',
            createArguments: {
              user: userParty,
              issuer: this.partyId,
              holdingId: params.holdingId,
              amount: params.amount,
              evmRecipient: params.evmRecipient,
              fingerprint: fingerprintHex,
            },
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

    const data = (await res.json()) as { updateId: string };
    this.logger.log(`DepositToPlasma created updateId=${data.updateId} holding=${params.holdingId}`);
    return { updateId: data.updateId };
  }

  // ─── wallet creation / connection ─────────────────────────────────────────

  /**
   * Deterministic fingerprint from username — same formula as local-setup.sh:
   *   cast keccak "User1"  →  keccak256(utf8("User1"))  →  strip 0x
   * Returns 64-char hex string (no 0x prefix) suitable for Daml Text storage.
   */
  computeFingerprint(username: string): string {
    return ethers.keccak256(ethers.toUtf8Bytes(username)).slice(2);
  }

  /**
   * Create-or-connect a Canton party by username.
   * If a FingerprintMapping already exists for keccak256(username), returns it.
   * Otherwise allocates a new party and creates the mapping.
   */
  async createOrConnectParty(username: string): Promise<{
    partyId: string;
    fingerprint: string;
    created: boolean;
  }> {
    const fpHex = this.computeFingerprint(username);

    // Check for existing FingerprintMapping (inline active-contracts fetch)
    const items = await this.fetchActiveContractsForParty(this.partyId);
    for (const item of items) {
      const ev = item?.contractEntry?.JsActiveContract?.createdEvent;
      if (!ev?.templateId?.includes('FingerprintMapping')) continue;
      const args = ev.createArgument as { fingerprint: string; userParty: string };
      if (args.fingerprint === fpHex) {
        this.logger.log(`Connecting existing party for username="${username}" fp=${fpHex}`);
        return { partyId: args.userParty, fingerprint: fpHex, created: false };
      }
    }

    // Not found — allocate a new party and create the mapping
    const partyId = await this.allocateParty(username);
    await this.createFingerprintMapping(partyId, fpHex);
    this.logger.log(`Created new party for username="${username}" partyId=${partyId} fp=${fpHex}`);
    return { partyId, fingerprint: fpHex, created: true };
  }

  private async allocateParty(hint: string): Promise<string> {
    const res = await fetch(`${this.baseUrl}/v2/parties`, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify({ partyIdHint: hint, displayName: hint }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Party allocation failed ${res.status}: ${text}`);
    }
    const data = (await res.json()) as { partyDetails?: { party: string } };
    const party = data.partyDetails?.party;
    if (!party) throw new Error('Canton returned no party ID');
    return party;
  }

  private async createFingerprintMapping(
    userParty: string,
    fpHex: string,
    evmAddress?: string,
  ): Promise<void> {
    const body = {
      actAs: [this.partyId],
      userId: this.userId,
      commandId: `create-fp-${fpHex.slice(0, 8)}-${Date.now()}`,
      commands: [
        {
          CreateCommand: {
            templateId: '#canton-bridge:Common.FingerprintAuth:FingerprintMapping',
            createArguments: {
              issuer: this.partyId,
              userParty,
              fingerprint: fpHex,
              evmAddress: evmAddress ?? null,
            },
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
      throw new Error(`FingerprintMapping creation failed: ${text}`);
    }
  }

  /** Shared active-contracts fetch used by createOrConnectParty. */
  private async fetchActiveContractsForParty(partyId: string): Promise<ContractItem[]> {
    const endRes = await fetch(`${this.baseUrl}/v2/state/ledger-end`, {
      headers: this.buildHeaders(),
    });
    if (!endRes.ok) throw new Error(`Failed to fetch ledger-end: ${endRes.status}`);
    const { offset } = (await endRes.json()) as { offset: string };

    const res = await fetch(`${this.baseUrl}/v2/state/active-contracts`, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify({
        activeAtOffset: offset ?? '',
        filter: { filtersByParty: { [partyId]: {} } },
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Failed to query active contracts: ${res.status} ${text}`);
    }
    return (await res.json()) as ContractItem[];
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
