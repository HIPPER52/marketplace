import { readFile } from 'node:fs/promises';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import type { Env } from '../../config/schemas/env.schema';
import { parseDatabaseUrl } from '../../config/utils/database-url.util';
import { ENTITIES } from '../constants/entities.constant';

/**
 * The application's DataSource, built from DATABASE_URL and the password file.
 *
 * DATABASE_URL carries no password by design — it names the host, the role and the
 * database, and nothing that has to be rotated. The password is a function rather than a
 * string on purpose: TypeORM hands it to pg, which calls it per connection, so
 * ./rotate.sh can replace the file under a running service and the next connection picks
 * up the new value without a restart.
 */
export async function createDataSource(config: ConfigService<Env, true>): Promise<DataSource> {
    const target = parseDatabaseUrl(config.get('DATABASE_URL', { infer: true }));
    const passwordFile = config.get('DB_PASSWORD_FILE', { infer: true });
    const logger = new Logger('DataSource');

    const dataSource = new DataSource({
        type: 'postgres',
        host: target.host,
        port: target.port,
        username: target.user,
        database: target.database,
        password: async () => (await readFile(passwordFile, 'utf8')).trim(),

        poolSize: config.get('DB_POOL_MAX', { infer: true }),
        uuidExtension: 'pgcrypto',

        // The schema is led by src/migrations/, reviewed and revertible. See data-source.ts.
        synchronize: false,
        migrationsRun: false,

        entities: ENTITIES,
        logging: ['error', 'warn'],
    });

    await dataSource.initialize();
    logger.log(`Connected to ${target.host}:${target.port}/${target.database}`);

    return dataSource;
}
