import { Module } from '@nestjs/common';
import { PlasmaService } from './plasma.service';
import { PlasmaController } from './plasma.controller';

@Module({
  providers: [PlasmaService],
  controllers: [PlasmaController],
  exports: [PlasmaService],
})
export class PlasmaModule {}
