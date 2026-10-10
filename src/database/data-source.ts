import 'reflect-metadata';
import { join } from 'node:path';
import { DataSource, type DataSourceOptions } from 'typeorm';
import { ENTITIES } from './constants/entities.constant';
import { readDatasourceEnv } from './schemas/datasource-env.schema';

const env = readDatasourceEnv(process.env);

/**
 * Shared by the DataSource below and by the one src/database/cli/demo-nplus1.ts builds
 * with a counting logger attached.
 */
export const dataSourceOptions: DataSourceOptions = {
    type: 'postgres',
    host: env.DB_HOST,
    port: env.DB_PORT,
    username: env.DB_USER,
    password: env.DB_PASSWORD,
    database: env.DB_NAME,

    /**
     * Generate uuid defaults as gen_random_uuid(), which Postgres has had built in since
     * 13, instead of uuid_generate_v4() from the uuid-ossp extension. Extensions need
     * rights the application role does not have and should not be given, and db/schema.sql
     * from HW-12 already uses the built-in — this keeps the two definitions identical.
     */
    uuidExtension: 'pgcrypto',

    /**
     * Never true, in any environment.
     *
     * synchronize compares entities to the live schema and issues whatever DDL closes the
     * gap — including `ALTER TABLE … DROP COLUMN`, silently, with the data in it. Renaming
     * a column in an entity is indistinguishable, to it, from deleting one and adding
     * another. The schema is led by the files in src/migrations/, which are reviewed
     * before they run and can be reverted after.
     */
    synchronize: false,
    migrationsRun: false,

    entities: ENTITIES,
    // __dirname is dist/database at runtime, so this is dist/migrations/*.js — compiled
    // migrations, which is also what the TypeORM CLI is pointed at.
    migrations: [join(__dirname, '..', 'migrations', '*.js')],

    logging: ['error', 'warn', 'migration'],
};

/**
 * The single DataSource export this file is allowed to have: the TypeORM CLI refuses a
 * module that exports two (`export default AppDataSource` alongside the named one counts
 * as two, even though it is the same instance).
 */
export const AppDataSource = new DataSource(dataSourceOptions);
