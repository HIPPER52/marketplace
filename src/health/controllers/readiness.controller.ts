import { Controller, Get } from '@nestjs/common';
import { Public } from '../../auth/decorators/public.decorator';
import { ProblemError, ProblemType } from '../../common/errors/problem.error';
import { DatabaseService } from '../../database/services/database.service';
import { Lifecycle } from '../services/lifecycle.service';

/**
 * Operational, not part of the contract — the same reason these two paths sit in the
 * validator's `ignorePaths`. A liveness probe that needed a token would need a way to
 * refresh one, and a container orchestrator has nowhere to keep it.
 *
 * This one answers "may I be sent traffic", which is a different question from the one
 * `/health` answers, and the two must never share a URL. A readiness probe wired into
 * `livenessProbe` turns "busy for a moment" into a restart, and the restart into a loop.
 */
@Public()
@Controller()
export class ReadinessController {
    constructor(
        private readonly database: DatabaseService,
        private readonly lifecycle: Lifecycle,
    ) {}

    @Get('readiness')
    async readiness() {
        // Asked before the database, because during a shutdown the pool is still perfectly
        // healthy and the answer is still no.
        if (this.lifecycle.isDraining) {
            throw new ProblemError({
                status: 503,
                type: ProblemType.internal,
                title: 'Service unavailable',
                detail: 'Shutting down: finishing requests in flight and taking no new ones.',
            });
        }

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
