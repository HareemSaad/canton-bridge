import { Module } from '@nestjs/common';
import { SubgraphService } from './subgraph.service';

@Module({
  providers: [SubgraphService],
  exports: [SubgraphService],
})
export class SubgraphModule {}
