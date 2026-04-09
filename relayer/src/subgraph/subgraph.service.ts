import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GraphQLClient, gql } from 'graphql-request';
import { FetchLocksResponse, LockDto } from './dto/lock.dto';

const FETCH_LOCKS_QUERY = gql`
  query FetchLocks($afterNonce: BigInt!, $first: Int!) {
    locks(
      where: { nonce_gt: $afterNonce }
      orderBy: nonce
      orderDirection: asc
      first: $first
    ) {
      id
      nonce
      token
      amount
      recipient
      toChain
      blockNumber
      blockTimestamp
      transactionHash
    }
  }
`;

@Injectable()
export class SubgraphService implements OnModuleInit {
  private readonly logger = new Logger(SubgraphService.name);
  private client: GraphQLClient;

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    const url = this.config.get<string>('subgraph.url');
    if (!url) {
      throw new Error('subgraph.url is not configured — check your .env');
    }
    this.client = new GraphQLClient(url);
    this.logger.log(`Subgraph client initialised → ${url}`);
  }

  async fetchLocksSinceNonce(
    afterNonce: string,
    pageSize: number,
  ): Promise<LockDto[]> {
    const data = await this.client.request<FetchLocksResponse>(
      FETCH_LOCKS_QUERY,
      {
        afterNonce,
        first: pageSize,
      },
    );
    return data.locks;
  }
}
