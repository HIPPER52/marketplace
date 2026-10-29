import { Controller, Get } from '@nestjs/common';
import { Public } from '../../auth/decorators/public.decorator';

/**
 * Operational, not part of the contract — the same reason these two paths sit in the
 * validator's `ignorePaths`. A liveness probe that needed a token would need a way to
 * refresh one, and a container orchestrator has nowhere to keep it.
 */
@Public()
@Controller()
export class HealthController {
    @Get('health')
    health() {
        return {
            status: 'ok',
            uptime_seconds: Math.round(process.uptime()),
        };
    }
}
