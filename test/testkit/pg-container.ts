import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DataSource } from 'typeorm';
import { ENTITIES } from '../../src/database/constants/entities.constant';
import {
    DEMO_BUYER_BALANCE_CENTS,
    DEMO_BUYER_EMAIL,
    DEMO_BUYER_ID,
} from '../../src/users/constants/demo-buyer.constant';

/**
 * The same major version the service runs on in docker-compose.yml and the same one the
 * restore drill restores into. Testing against a different major is the version-shaped
 * form of the mock's lie: everything passes, against a database nobody deploys.
 */
export const POSTGRES_IMAGE = 'postgres:17-alpine';

export interface PgHandle {
    container: StartedPostgreSqlContainer;
    dataSource: DataSource;
    /**
     * What the application's own configuration expects: a URL with no password in it and
     * a file to read the password from. The container hands out a URL with the password
     * inline, which src/config/utils/database-url.util.ts rejects on purpose — the shape
     * exists so that ./rotate.sh can replace a running service's password.
     */
    env: { DATABASE_URL: string; DB_PASSWORD_FILE: string };
    stop(): Promise<void>;
}

/**
 * One call, one real Postgres, with every migration applied.
 *
 * The schema comes from src/migrations/ rather than from db/schema.sql, because the
 * migrations are what a deployed database has actually run. Applying the SQL file instead
 * would test a schema that is maintained by hand next to the one that ships.
 */
export async function startPg(label = ''): Promise<PgHandle> {
    const startedAt = Date.now();

    const container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();

    const passwordDir = mkdtempSync(join(tmpdir(), 'marketplace-test-'));
    const passwordFile = join(passwordDir, 'db_password');
    writeFileSync(passwordFile, container.getPassword(), { mode: 0o600 });

    const databaseUrl =
        `postgres://${container.getUsername()}@` +
        `${container.getHost()}:${container.getPort()}/${container.getDatabase()}`;

    const dataSource = new DataSource({
        type: 'postgres',
        host: container.getHost(),
        port: container.getPort(),
        username: container.getUsername(),
        password: container.getPassword(),
        database: container.getDatabase(),
        uuidExtension: 'pgcrypto',
        synchronize: false,
        migrationsRun: false,
        entities: ENTITIES,
        migrations: [join(__dirname, '..', '..', 'src', 'migrations', '*.ts')],
        // Expected failures are the subject of several tests; logging them as errors
        // buries the reporter's output in stack traces that are not news.
        logging: ['migration'],
    });

    await dataSource.initialize();
    const applied = await dataSource.runMigrations({ transaction: 'all' });

    console.log(
        `[testkit] ${POSTGRES_IMAGE}${label === '' ? '' : ` ${label}`} ready in ` +
            `${Date.now() - startedAt} ms, ${applied.length} migrations applied`,
    );

    return {
        container,
        dataSource,
        env: { DATABASE_URL: databaseUrl, DB_PASSWORD_FILE: passwordFile },
        async stop() {
            if (dataSource.isInitialized) {
                await dataSource.destroy();
            }
            await container.stop();
            rmSync(passwordDir, { recursive: true, force: true });
        },
    };
}

/**
 * The isolation strategy: empty every table between tests, then put back the one row the
 * schema is not complete without.
 *
 * TRUNCATE rather than the lecture's BEGIN … ROLLBACK, and the reason is in this
 * repository rather than in taste. CheckoutService runs its work inside its own
 * `dataSource.transaction()`, retried on 40001 — it commits. A test that wrapped it in an
 * outer transaction would be testing a transaction that never ends, and the retry
 * wrapper's whole subject, a transaction being replayed, cannot happen inside one.
 * TRUNCATE … RESTART IDENTITY CASCADE costs single-digit milliseconds on tables this
 * size and leaves nothing behind, which is what makes two consecutive runs of the suite
 * identical.
 */
export async function truncateAll(dataSource: DataSource): Promise<void> {
    await dataSource.query(
        'TRUNCATE TABLE "jobs", "order_items", "orders", "products", "users" RESTART IDENTITY CASCADE',
    );
}

/**
 * Re-seats the account POST /orders debits. TRUNCATE takes it with everything else, and
 * the migration that created it has already run, so the row has to come back by hand.
 *
 * `ON CONFLICT DO NOTHING` so that calling it twice — which the Pact state handlers do,
 * once per interaction — is not an error.
 */
export async function seatDemoBuyer(dataSource: DataSource): Promise<void> {
    await dataSource.query(
        `INSERT INTO "users" ("id", "email", "display_name", "balance_cents")
         OVERRIDING SYSTEM VALUE
         VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING`,
        [DEMO_BUYER_ID, DEMO_BUYER_EMAIL, 'Demo buyer', DEMO_BUYER_BALANCE_CENTS],
    );

    await dataSource.query(
        `SELECT setval(
             pg_get_serial_sequence('users', 'id'),
             GREATEST((SELECT max(id) FROM "users"), $1::bigint)
         )`,
        [DEMO_BUYER_ID],
    );
}
