import { Module } from '@nestjs/common';
import { CantonService } from './canton.service';
import { CantonQueryService } from './canton-query.service';
import { CantonController } from './canton.controller';

@Module({
  providers: [CantonService, CantonQueryService],
  controllers: [CantonController],
  exports: [CantonService, CantonQueryService],
})
export class CantonModule {}
