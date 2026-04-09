import { Module } from '@nestjs/common';
import { CantonService } from './canton.service';

@Module({
  providers: [CantonService],
  exports: [CantonService],
})
export class CantonModule {}
