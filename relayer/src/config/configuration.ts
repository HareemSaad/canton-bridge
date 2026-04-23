type Mode = 'local' | 'prod';

export default () => {
  const mode = (process.env.MODE ?? 'local') as Mode;

  const profiles: Record<
    Mode,
    {
      databaseUrl: string | undefined;
      subgraphUrl: string | undefined;
      plasmaRpc: string | undefined;
      relayerPrivateKey: string | undefined;
      cantonBridgeAddress: string | undefined;
      evmTokenAddress: string | undefined;
      chainId: string | undefined;
      cantonUrl: string | undefined;
      cantonPartyId: string | undefined;
      cantonToken: string | undefined;
      cantonUserId: string | undefined;
      cantonTokenConfigId: string | undefined;
      cantonBridgeStateId: string | undefined;
    }
  > = {
    local: {
      databaseUrl: process.env.LOCAL_DATABASE_URL,
      subgraphUrl: process.env.LOCAL_SUBGRAPH_URL,
      plasmaRpc: process.env.LOCAL_PLASMA_RPC,
      relayerPrivateKey: process.env.LOCAL_RELAYER_PRIVATE_KEY,
      cantonBridgeAddress: process.env.LOCAL_CANTON_BRIDGE_ADDRESS,
      evmTokenAddress: process.env.LOCAL_EVM_TOKEN_ADDRESS,
      chainId: process.env.LOCAL_CHAIN_ID,
      cantonUrl: process.env.LOCAL_CANTON_URL,
      cantonPartyId: process.env.LOCAL_CANTON_PARTY_ID,
      cantonToken: process.env.LOCAL_CANTON_TOKEN,
      cantonUserId: process.env.LOCAL_CANTON_USER_ID,
      cantonTokenConfigId: process.env.LOCAL_TOKEN_CONFIG_ID,
      cantonBridgeStateId: process.env.LOCAL_BRIDGE_STATE_ID,
    },
    prod: {
      databaseUrl: process.env.PROD_DATABASE_URL,
      subgraphUrl: process.env.PROD_SUBGRAPH_URL,
      plasmaRpc: process.env.PROD_PLASMA_RPC,
      relayerPrivateKey: process.env.PROD_RELAYER_PRIVATE_KEY,
      cantonBridgeAddress: process.env.PROD_CANTON_BRIDGE_ADDRESS,
      evmTokenAddress: process.env.PROD_EVM_TOKEN_ADDRESS,
      chainId: process.env.PROD_CHAIN_ID,
      cantonUrl: process.env.PROD_CANTON_URL,
      cantonPartyId: process.env.PROD_CANTON_PARTY_ID,
      cantonToken: process.env.PROD_CANTON_TOKEN,
      cantonUserId: process.env.PROD_CANTON_USER_ID,
      cantonTokenConfigId: process.env.PROD_TOKEN_CONFIG_ID,
      cantonBridgeStateId: process.env.PROD_BRIDGE_STATE_ID,
    },
  };

  const profile = profiles[mode];

  return {
    mode,
    port: parseInt(process.env.PORT ?? '3000', 10),
    nodeEnv: process.env.NODE_ENV ?? 'development',
    database: {
      url: profile.databaseUrl,
    },
    subgraph: {
      url: profile.subgraphUrl,
      pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS ?? '30000', 10),
      pageSize: parseInt(process.env.SUBGRAPH_PAGE_SIZE ?? '100', 10),
    },
    plasma: {
      rpc: profile.plasmaRpc,
      relayerPrivateKey: profile.relayerPrivateKey,
      cantonBridgeAddress: profile.cantonBridgeAddress,
      evmTokenAddress: profile.evmTokenAddress,
      chainId: profile.chainId,
      withdrawalPollMs: parseInt(
        process.env.LOCAL_WITHDRAWAL_POLL_MS ?? process.env.WITHDRAWAL_POLL_MS ?? '30000',
        10,
      ),
    },
    canton: {
      pendingCheckIntervalMs: parseInt(
        process.env.PENDING_CHECK_INTERVAL_MS ?? '60000',
        10,
      ),
      url: profile.cantonUrl,
      partyId: profile.cantonPartyId,
      token: profile.cantonToken,
      userId: profile.cantonUserId ?? 'sandbox',
      tokenDecimals: parseInt(process.env.CANTON_TOKEN_DECIMALS ?? '6', 10),
      // CIP-56 contract IDs (populated by local-setup.sh / prod deploy)
      tokenConfigId: profile.cantonTokenConfigId,
      bridgeStateId: profile.cantonBridgeStateId,
    },
  };
};
