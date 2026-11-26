import { Module } from '@nestjs/common';
import { HealthController } from './controllers/health.controller';
import { ReadinessController } from './controllers/readiness.controller';
import { Lifecycle } from './services/lifecycle.service';

@Module({
    controllers: [HealthController, ReadinessController],
    providers: [Lifecycle],
    // main.ts resolves it to flip readiness on SIGTERM; the readiness controller reads it.
    exports: [Lifecycle],
})
export class HealthModule {}
