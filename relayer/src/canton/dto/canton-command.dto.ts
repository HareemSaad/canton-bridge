// ── MintCommand flow (production: CIP-56 via TokenConfig.IssuerMint) ──────────

export interface MintCommandArgs {
  issuer: string;
  recipient: string;
  amount: string;            // Daml Decimal string e.g. "1.000000"
  txHash: string;            // EVM transaction hash
  fingerprint: string;       // EVM bytes32 fingerprint (hex, no 0x prefix)
  chainRef: string;          // source chain name e.g. "plasma"
  tokenConfigId: string;     // Canton ContractId of TokenConfig
  bridgeStateId: string;     // Canton ContractId of BridgeState
}

export interface MintCommandCreateAndExercise {
  CreateAndExerciseCommand: {
    templateId: string;      // '#canton-bridge:Bridge.Contracts:MintCommand'
    createArguments: MintCommandArgs;
    choice: 'Execute';
    choiceArgument: { dummy: Record<string, never> };
  };
}

// ── Shared request / response types ──────────────────────────────────────────

export interface CantonSubmitRequest {
  actAs: string[];
  userId: string;
  commandId: string;
  commands: MintCommandCreateAndExercise[];
}

export interface CantonSubmitResponse {
  updateId: string;
  completionOffset: number;
}

// ── Legacy types (kept for backward compatibility with old POC flow) ───────────

export interface BridgeReceiverArgs {
  bridgeOperator: string;
  recipient: string;
  plasmaToken: string;
  plasmaTxHash: string;
  nonce: number;
  amount: string;
}

export interface LegacyCreateAndExerciseCommand {
  CreateAndExerciseCommand: {
    templateId: string;
    createArguments: BridgeReceiverArgs;
    choice: string;
    choiceArgument: Record<string, never>;
  };
}
