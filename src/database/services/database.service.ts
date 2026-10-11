import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { DATA_SOURCE } from '../constants/database.constants';

/**
 * Owns the lifetime of the connection and answers the readiness probe.
 *
 * `ping` runs on the same DataSource the repositories use, so a readiness check that
 * passes means the pool serving requests is the pool that answered.
 */
@Injectable()
export class DatabaseService implements OnModuleDestroy {
    private readonly logger = new Logger(DatabaseService.name);

    constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}

    async ping(): Promise<void> {
        await this.dataSource.query('SELECT 1');
    }

    async onModuleDestroy(): Promise<void> {
        if (this.dataSource.isInitialized) {
            await this.dataSource.destroy();
            this.logger.log('Postgres pool closed');
        }
    }
}
