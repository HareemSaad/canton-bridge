type Mode = 'local' | 'prod';

const profiles: Record<
  Mode,
  {
    databaseUrl: string | undefined;
    subgraphUrl: string | undefined;
    plasmaRpc: string | undefined;
  }
> = {
  local: {
    databaseUrl: process.env.LOCAL_DATABASE_URL,
    subgraphUrl: process.env.LOCAL_SUBGRAPH_URL,
    plasmaRpc: process.env.LOCAL_PLASMA_RPC,
  },
  prod: {
    databaseUrl: process.env.PROD_DATABASE_URL,
    subgraphUrl: process.env.PROD_SUBGRAPH_URL,
    plasmaRpc: process.env.PROD_PLASMA_RPC,
  },
};

export default () => {
  const mode = (process.env.MODE ?? 'local') as Mode;
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
    },
    canton: {
      pendingCheckIntervalMs: parseInt(
        process.env.PENDING_CHECK_INTERVAL_MS ?? '60000',
        10,
      ),
    },
  };
};
