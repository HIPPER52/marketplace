import { readFile } from 'node:fs/promises';
import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, type QueryResult, type QueryResultRow } from 'pg';
import type { Env } from '../../config/schemas/env.schema';
import { parseDatabaseUrl } from '../../config/utils/database-url.util';
import { PG_POOL } from '../constants/database.constants';

@Injectable()
export class DatabaseService implements OnModuleDestroy {
    private readonly logger = new Logger(DatabaseService.name);

    constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

    query<T extends QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<T>> {
        return this.pool.query<T>(text, values);
    }

    async ping(): Promise<void> {
        await this.pool.query('SELECT 1');
    }

    async onModuleDestroy(): Promise<void> {
        await this.pool.end();
        this.logger.log('Postgres pool closed');
    }
}

export function createPool(config: ConfigService<Env, true>): Pool {
    const target = parseDatabaseUrl(config.get('DATABASE_URL', { infer: true }));
    const passwordFile = config.get('DB_PASSWORD_FILE', { infer: true });
    const logger = new Logger('PgPool');

    const pool = new Pool({
        host: target.host,
        port: target.port,
        database: target.database,
        user: target.user,
        max: config.get('DB_POOL_MAX', { infer: true }),

        password: async () => (await readFile(passwordFile, 'utf8')).trim(),
    });

    pool.on('error', (error) => {
        logger.warn(`Idle client dropped: ${error.message}`);
    });

    return pool;
}
