import 'reflect-metadata';
import { AppDataSource } from '../data-source';

/**
 * Runs the pending migrations and exits. The same thing `npm run migrate` does through
 * the TypeORM CLI, in a form a **distroless image can start**.
 *
 * The production image has no shell, no npm and no `npx`: its entrypoint is node and its
 * command is a path to a file. `typeorm migration:run` is a shell line, so the cluster's
 * migration Job cannot be that line — it is `node dist/database/cli/migrate.js`, which is
 * the same DataSource, the same compiled migrations in dist/migrations/, and the same
 * `migrations` bookkeeping table.
 *
 * A Job and not an init container, because an init container runs once per pod: two
 * replicas would start two migration runs against one database, and a schema change is
 * not a race anybody wants to find out they entered. A Job runs once per deployment.
 */
async function main(): Promise<void> {
    await AppDataSource.initialize();

    try {
        const applied = await AppDataSource.runMigrations({ transaction: 'each' });

        if (applied.length === 0) {
            console.log('migrations: nothing pending');
        } else {
            for (const migration of applied) {
                console.log(`migrations: applied ${migration.name}`);
            }
        }

        console.log(`migrations-applied=${applied.length}`);
    } finally {
        await AppDataSource.destroy();
    }
}

main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\nMigration run failed.\n\n${message}\n`);
    process.exit(1);
});
