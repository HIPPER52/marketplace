import { Controller, Get } from '@nestjs/common';
import { ProblemError, ProblemType } from '../../common/errors/problem.error';
import { DatabaseService } from '../../database/services/database.service';

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
