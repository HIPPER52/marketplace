import { Controller, Get } from '@nestjs/common';
import { Public } from '../../auth/decorators/public.decorator';
import { ProblemError, ProblemType } from '../../common/errors/problem.error';
import { DatabaseService } from '../../database/services/database.service';

/**
 * Operational, not part of the contract — the same reason these two paths sit in the
 * validator's `ignorePaths`. A liveness probe that needed a token would need a way to
 * refresh one, and a container orchestrator has nowhere to keep it.
 */
@Public()
@Controller()
export class ReadinessController {
    constructor(private readonly database: DatabaseService) {}

    @Get('readiness')
    async readiness() {
        try {
            await this.database.ping();
        } catch (error) {
            throw new ProblemError({
                status: 503,
                type: ProblemType.internal,
                title: 'Service unavailable',
                detail: `Database is not reachable: ${(error as Error).message}`,
            });
        }

        return { status: 'ready', database: 'ok' };
    }
}
