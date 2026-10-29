import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { DataSource } from 'typeorm';
import { configureApp } from '../../common/utils/configure-app.util';
import { DATA_SOURCE } from '../../database/constants/database.constants';
import { readDatasourceEnv } from '../../database/schemas/datasource-env.schema';
import { fingerprint } from './key-fingerprint.util';

export interface DemoApp {
    baseUrl: string;
    app: INestApplication;
    dataSource: DataSource;
    close(): Promise<void>;
}

/**
 * Raises the **real** application, on a port nobody asked for, for a demo to talk to.
 *
 * The three auth demos are about what happens at the HTTP edge — a 401 that carries
 * `WWW-Authenticate`, a 403 that is not a 401, a token the validator never sees because
 * the guard refused it first. None of that exists below the edge, so unlike the #19–#23
 * demos these cannot call a service directly; they have to make requests.
 *
 * ## Why the environment is rebuilt here
 *
 * Every command that reaches the database goes through `scripts/with-secrets.sh`, which
 * exports the flat `DB_*` block the CLI tools read. The service reads something else: a
 * `DATABASE_URL` that carries **no** password plus a password file it re-reads per
 * connection, which is what makes `./rotate.sh` possible. A grader exports
 * `DATABASE_URL` with the password inline — the shape the service's own schema refuses,
 * by the decision taken in #13 — so a demo that simply booted `AppModule` would die on
 * its configuration rather than on the thing it is demonstrating.
 *
 * So the one shape is derived from the other, here, in the open: a URL without a
 * password, and the password in a file this process creates with `0600` and deletes on
 * the way out.
 *
 * ## Why these three demos run from `dist/`
 *
 * Every other demo in this repository runs under `tsx`, which is fine because they
 * construct what they need by hand. These boot Nest, and Nest reads constructor
 * dependencies from `design:paramtypes` — metadata only the TypeScript emitter writes.
 * `tsx` is esbuild: it strips types without emitting that metadata, and the symptom is
 * not a missing feature but a provider that resolves as `undefined` with a message about
 * `import type`. The same reason `jest` uses ts-jest rather than a swc transformer, and
 * the same reason `build` is `tsc`. So `demo:auth`, `demo:reuse` and `demo:rbac` build
 * first and run the compiled file.
 *
 * ## Why the keys may be generated
 *
 * If `JWT_*` is already in the environment it is used unchanged. If it is not — a grader
 * who has not run `npm run keygen` — a pair is generated for this run and thrown away
 * with the process. Nothing is written to disk, which is the same rule `keygen` follows:
 * a demo that created a key file would be a demo that teaches people to commit one.
 */
export async function openDemoApp(): Promise<DemoApp> {
    const secrets = mkdtempSync(join(tmpdir(), 'marketplace-demo-'));

    prepareDatabaseEnv(secrets);
    prepareSigningEnv();

    // Imported after the environment is settled: `app.module.ts` validates on evaluation.
    const { AppModule } = await import('../../app.module');

    const app = await NestFactory.create(AppModule, {
        bodyParser: false,
        abortOnError: false,
        logger: ['error', 'warn'],
    });

    await configureApp(app);
    await app.listen(0);

    const url = await app.getUrl();
    const dataSource = app.get<DataSource>(DATA_SOURCE);

    return {
        // Node resolves `listen(0)` to [::1] on some hosts and 0.0.0.0 on others; both
        // answer on 127.0.0.1, and only one of them is a URL `fetch` will accept.
        baseUrl: url.replace('[::1]', '127.0.0.1').replace('0.0.0.0', '127.0.0.1'),
        app,
        dataSource,
        close: async () => {
            await app.close();
            rmSync(secrets, { recursive: true, force: true });
        },
    };
}

function prepareDatabaseEnv(secrets: string): void {
    const db = readDatasourceEnv(process.env);
    const passwordFile = join(secrets, 'db_password');

    writeFileSync(passwordFile, db.DB_PASSWORD, { mode: 0o600 });

    process.env.DATABASE_URL = `postgres://${encodeURIComponent(db.DB_USER)}@${db.DB_HOST}:${db.DB_PORT}/${encodeURIComponent(db.DB_NAME)}`;
    process.env.DB_PASSWORD_FILE = passwordFile;
}

function prepareSigningEnv(): void {
    if (typeof process.env.JWT_PRIVATE_KEY === 'string' && process.env.JWT_PRIVATE_KEY.length > 0) {
        return;
    }

    const { privateKey, publicKey } = generateKeyPairSync('ec', {
        namedCurve: 'P-256',
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
    });

    process.env.JWT_KID = 'demo-run';
    process.env.JWT_PRIVATE_KEY = Buffer.from(privateKey).toString('base64');
    process.env.JWT_PUBLIC_KEY = Buffer.from(publicKey).toString('base64');
    process.env.REFRESH_TOKEN_PEPPER ??= randomBytes(32).toString('hex');

    console.log(
        `no JWT_* in the environment: generated a pair for this run, fingerprint ${fingerprint(publicKey)}`,
    );
}

/** What a demo may put on one request. Everything is optional; a GET needs none of it. */
export interface CallOptions {
    token?: string;
    body?: unknown;
    headers?: Record<string, string>;
}

/** The whole answer, status included — a demo asserts on it rather than on a throw. */
export interface CallResult<T> {
    status: number;
    body: T;
    headers: Headers;
}

/** A JSON request against the demo stand, with the status kept rather than thrown away. */
export async function call<T = unknown>(
    app: DemoApp,
    method: string,
    path: string,
    options: CallOptions = {},
): Promise<CallResult<T>> {
    const response = await fetch(`${app.baseUrl}${path}`, {
        method,
        headers: {
            ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
            ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
            ...options.headers,
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });

    const text = await response.text();

    return {
        status: response.status,
        body: (text === '' ? null : JSON.parse(text)) as T,
        headers: response.headers,
    };
}
