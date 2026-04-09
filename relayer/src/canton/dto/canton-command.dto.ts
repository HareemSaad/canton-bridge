export interface CreateAndExerciseCommand {
  CreateAndExerciseCommand: {
    templateId: string;
    createArguments: BridgeReceiverArgs;
    choice: string;
    choiceArgument: Record<string, never>;
  };
}

export interface BridgeReceiverArgs {
  bridgeOperator: string;
  recipient: string;
  plasmaToken: string;
  plasmaTxHash: string;
  nonce: number;
  amount: string;
}

export interface CantonSubmitRequest {
  actAs: string[];
  userId: string;
  commandId: string;
  commands: CreateAndExerciseCommand[];
}

export interface CantonSubmitResponse {
  updateId: string;
  completionOffset: number;
}
