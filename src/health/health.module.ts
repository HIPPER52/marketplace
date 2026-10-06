import { Module } from '@nestjs/common';
import { HealthController } from './controllers/health.controller';
import { ReadinessController } from './controllers/readiness.controller';

@Module({ controllers: [HealthController, ReadinessController] })
export class HealthModule {}
