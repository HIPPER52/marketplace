const POSTGRES_PROTOCOLS = ['postgres:', 'postgresql:'] as const;
const DEFAULT_POSTGRES_PORT = 5432;

export interface DatabaseTarget {
    host: string;
    port: number;
    database: string;
    user: string;
}

export function parseDatabaseUrl(raw: string): DatabaseTarget {
    let url: URL;

    try {
        url = new URL(raw);
    } catch {
        return fail('must be a URL, e.g. postgres://marketplace_app@localhost:5432/marketplace');
    }

    if (!POSTGRES_PROTOCOLS.includes(url.protocol as (typeof POSTGRES_PROTOCOLS)[number])) {
        return fail(`must use one of ${POSTGRES_PROTOCOLS.join(' / ')}, got ${url.protocol}`);
    }

    if (url.password !== '') {
        return fail(
            'must not carry a password: the password is read from the file named by ' +
                'DB_PASSWORD_FILE so that it can be rotated without a restart',
        );
    }

    const user = decodeURIComponent(url.username);
    const database = decodeURIComponent(url.pathname.replace(/^\//, ''));

    if (user === '') {
        return fail('must name the database role, e.g. postgres://marketplace_app@host/db');
    }

    if (database === '') {
        return fail('must name the database, e.g. postgres://marketplace_app@host/marketplace');
    }

    return {
        host: url.hostname,
        port: url.port === '' ? DEFAULT_POSTGRES_PORT : Number(url.port),
        database,
        user,
    };
}

export function databaseUrlProblem(raw: string): string | null {
    try {
        parseDatabaseUrl(raw);
        return null;
    } catch (error) {
        return error instanceof Error ? error.message : 'is not a valid connection string';
    }
}

function fail(reason: string): never {
    throw new Error(reason);
}
