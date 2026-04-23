import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ethers } from 'ethers';

@Injectable()
export class WithdrawalWatcherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WithdrawalWatcherService.name);

  private pollTimer: NodeJS.Timeout | null = null;

  private cantonUrl: string;
  private partyId: string;
  private cantonToken: string | undefined;
  private userId: string;
  private tokenDecimals: number;
  private tokenConfigId: string;

  private relayerPrivateKey: string;
  private cantonBridgeAddress: string;
  private evmTokenAddress: string;
  private chainId: bigint;
  private plasmaRpc: string;

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    const cantonUrl = this.config.get<string>('canton.url');
    const partyId = this.config.get<string>('canton.partyId');
    const tokenConfigId = this.config.get<string>('canton.tokenConfigId');
    const relayerPrivateKey = this.config.get<string>('plasma.relayerPrivateKey');
    const cantonBridgeAddress = this.config.get<string>('plasma.cantonBridgeAddress');
    const evmTokenAddress = this.config.get<string>('plasma.evmTokenAddress');
    const chainId = this.config.get<string>('plasma.chainId');
    const plasmaRpc = this.config.get<string>('plasma.rpc');

    if (!cantonUrl) throw new Error('canton.url is not configured');
    if (!partyId) throw new Error('canton.partyId is not configured');
    if (!tokenConfigId) throw new Error('canton.tokenConfigId is not configured');
    if (!relayerPrivateKey) throw new Error('plasma.relayerPrivateKey is not configured — check LOCAL_RELAYER_PRIVATE_KEY');
    if (!cantonBridgeAddress) throw new Error('plasma.cantonBridgeAddress is not configured — check LOCAL_CANTON_BRIDGE_ADDRESS');
    if (!evmTokenAddress) throw new Error('plasma.evmTokenAddress is not configured — check LOCAL_EVM_TOKEN_ADDRESS');
    if (!chainId) throw new Error('plasma.chainId is not configured — check LOCAL_CHAIN_ID');
    if (!plasmaRpc) throw new Error('plasma.rpc is not configured');

    this.cantonUrl = cantonUrl;
    this.partyId = partyId;
    this.cantonToken = this.config.get<string>('canton.token') || undefined;
    this.userId = this.config.get<string>('canton.userId') ?? 'sandbox';
    this.tokenDecimals = this.config.get<number>('canton.tokenDecimals') ?? 6;
    this.tokenConfigId = tokenConfigId;
    this.relayerPrivateKey = relayerPrivateKey;
    this.cantonBridgeAddress = cantonBridgeAddress;
    this.evmTokenAddress = evmTokenAddress;
    this.chainId = BigInt(chainId);
    this.plasmaRpc = plasmaRpc;

    const pollMs = this.config.get<number>('plasma.withdrawalPollMs') ?? 30_000;
    this.logger.log(`WithdrawalWatcher started (poll every ${pollMs}ms)`);
    this.logger.log(`Canton → Plasma via CantonBridge: ${this.cantonBridgeAddress}`);

    void this.poll();
    this.pollTimer = setInterval(() => void this.poll(), pollMs);
  }

  onModuleDestroy() {
    if (this.pollTimer) clearInterval(this.pollTimer);
  }

  // ─── main poll ───────────────────────────────────────────────────────────────

  private async poll(): Promise<void> {
    try {
      const items = await this.fetchActiveContracts();

      // Phase 1: accept pending DepositToPlasma requests (burns holding)
      const depositRequests = items.filter((i) => {
        const templateId = this.getTemplateId(i) ?? '';
        return templateId.includes('DepositToPlasma') && !templateId.includes('DepositToPlasmaEvent');
      });

      if (depositRequests.length > 0) {
        this.logger.log(`${depositRequests.length} DepositToPlasma request(s) to accept`);
        for (const item of depositRequests) {
          await this.acceptDepositRequest(item);
        }
      }

      // Phase 2: relay pending DepositToPlasmaEvent to EVM
      const pendingEvents = items.filter((i) => {
        const templateId = this.getTemplateId(i) ?? '';
        if (!templateId.includes('DepositToPlasmaEvent')) return false;
        return JSON.stringify(this.getArgs(i)).includes('DepositPending');
      });

      if (pendingEvents.length > 0) {
        this.logger.log(`${pendingEvents.length} DepositToPlasmaEvent(s) to relay to EVM`);
        for (const item of pendingEvents) {
          await this.relayToEvm(item);
        }
      }
    } catch (err) {
      this.logger.error('Poll failed', (err as Error).message);
    }
  }

  // ─── phase 1: accept DepositToPlasma (burns holding) ─────────────────────────

  private async acceptDepositRequest(item: ContractItem): Promise<void> {
    const contractId = this.getContractId(item)!;
    const args = this.getArgs(item) as { evmRecipient: string; amount: string };
    this.logger.log(`Accepting DepositToPlasma contractId=${contractId} amount=${args.amount} to=${args.evmRecipient}`);

    try {
      await this.submitCommand({
        ExerciseCommand: {
          templateId: '#canton-bridge:Bridge.Contracts:DepositToPlasma',
          contractId,
          choice: 'Accept',
          choiceArgument: { tokenConfigId: this.tokenConfigId },
        },
      }, `deposit-accept-${contractId.slice(0, 16)}`);
      this.logger.log(`Accepted DepositToPlasma contractId=${contractId} — holding burned`);
    } catch (err) {
      this.logger.error(`Failed to accept DepositToPlasma contractId=${contractId}: ${(err as Error).message}`);
    }
  }

  // ─── phase 2: relay DepositToPlasmaEvent to EVM ───────────────────────────────

  private async relayToEvm(item: ContractItem): Promise<void> {
    const contractId = this.getContractId(item)!;
    const args = this.getArgs(item) as { amount: string; evmRecipient: string };
    this.logger.log(`Relaying DepositToPlasmaEvent contractId=${contractId} amount=${args.amount} to=${args.evmRecipient}`);

    try {
      const rawAmount = this.fromCantonDecimal(args.amount, this.tokenDecimals);
      // withdrawalId = keccak256 of the Canton contract ID — unique per event
      const withdrawalId = ethers.id(contractId);

      const proof = await this.signWithdrawalProof(rawAmount, args.evmRecipient, withdrawalId);
      const evmTxHash = await this.submitWithdrawalOnEvm(rawAmount, args.evmRecipient, withdrawalId, proof);

      await this.submitCommand({
        ExerciseCommand: {
          templateId: '#canton-bridge:Bridge.Contracts:DepositToPlasmaEvent',
          contractId,
          choice: 'Complete',
          choiceArgument: { evmTxHash },
        },
      }, `deposit-complete-${contractId.slice(0, 16)}`);

      this.logger.log(`DepositToPlasmaEvent complete contractId=${contractId} evmTx=${evmTxHash}`);
    } catch (err) {
      const reason = (err as Error).message;
      this.logger.error(`Failed to relay DepositToPlasmaEvent contractId=${contractId}: ${reason}`);
      await this.submitCommand({
        ExerciseCommand: {
          templateId: '#canton-bridge:Bridge.Contracts:DepositToPlasmaEvent',
          contractId,
          choice: 'Fail',
          choiceArgument: { reason },
        },
      }, `deposit-fail-${contractId.slice(0, 16)}`).catch(() => {});
    }
  }

  // ─── EVM signing + submission ────────────────────────────────────────────────

  private async signWithdrawalProof(
    rawAmount: bigint,
    evmRecipient: string,
    withdrawalId: string,
  ): Promise<string> {
    const wallet = new ethers.Wallet(this.relayerPrivateKey);
    // Matches Solidity: keccak256(abi.encodePacked(token, amount, recipient, withdrawalId, chainid))
    const msgHash = ethers.solidityPackedKeccak256(
      ['address', 'uint256', 'address', 'bytes32', 'uint256'],
      [this.evmTokenAddress, rawAmount, evmRecipient, withdrawalId, this.chainId],
    );
    return wallet.signMessage(ethers.getBytes(msgHash));
  }

  private async submitWithdrawalOnEvm(
    rawAmount: bigint,
    evmRecipient: string,
    withdrawalId: string,
    proof: string,
  ): Promise<string> {
    const provider = new ethers.JsonRpcProvider(this.plasmaRpc);
    const wallet = new ethers.Wallet(this.relayerPrivateKey, provider);
    const iface = new ethers.Interface([
      'function withdrawFromCanton(address token, uint256 amount, address recipient, bytes32 withdrawalId, bytes calldata proof)',
    ]);
    const contract = new ethers.Contract(this.cantonBridgeAddress, iface, wallet);
    const tx = await (
      contract.withdrawFromCanton as (...args: unknown[]) => Promise<ethers.TransactionResponse>
    )(this.evmTokenAddress, rawAmount, evmRecipient, withdrawalId, proof);
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) {
      throw new Error(`EVM tx reverted: ${tx.hash}`);
    }
    return tx.hash;
  }

  // ─── Canton API helpers ───────────────────────────────────────────────────────

  private async fetchActiveContracts(): Promise<ContractItem[]> {
    const endRes = await fetch(`${this.cantonUrl}/v2/state/ledger-end`, {
      headers: this.buildHeaders(),
    });
    if (!endRes.ok) throw new Error(`Failed to fetch ledger-end: ${endRes.status}`);
    const endData = (await endRes.json()) as { offset: string };
    const activeAtOffset = endData.offset ?? '';

    const res = await fetch(`${this.cantonUrl}/v2/state/active-contracts`, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify({
        activeAtOffset,
        filter: { filtersByParty: { [this.partyId]: {} } },
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Failed to query active contracts: ${res.status} ${text}`);
    }
    return (await res.json()) as ContractItem[];
  }

  private async submitCommand(command: Record<string, unknown>, commandId: string): Promise<void> {
    const body = {
      actAs: [this.partyId],
      userId: this.userId,
      commandId,
      commands: [command],
    };
    const res = await fetch(`${this.cantonUrl}/v2/commands/submit-and-wait`, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Canton command failed ${res.status}: ${text}`);
    }
  }

  // ─── contract item helpers ────────────────────────────────────────────────────

  private getTemplateId(item: ContractItem): string | undefined {
    return item?.contractEntry?.JsActiveContract?.createdEvent?.templateId;
  }

  private getContractId(item: ContractItem): string | undefined {
    return item?.contractEntry?.JsActiveContract?.createdEvent?.contractId;
  }

  private getArgs(item: ContractItem): Record<string, unknown> {
    return item?.contractEntry?.JsActiveContract?.createdEvent?.createArgument ?? {};
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.cantonToken) headers['Authorization'] = `Bearer ${this.cantonToken}`;
    return headers;
  }

  // "1.000000" → 1000000n
  private fromCantonDecimal(s: string, decimals: number): bigint {
    const [whole, frac = ''] = s.split('.');
    const fracPadded = frac.padEnd(decimals, '0').slice(0, decimals);
    return BigInt(whole) * BigInt(10 ** decimals) + BigInt(fracPadded);
  }
}

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
