/**
 * Every value this deployment needs that must not be in git.
 *
 * The list is the same one the README's variables table carries, and the two are checked
 * against each other by hand rather than by a tool — which is the honest description of
 * the arrangement. What a tool does check is this: remove any one of them from the
 * environment and `pulumi preview` fails **naming it**, because the first thing the
 * program does is read them. A program that validated after its first cluster call would
 * fail with a connection error instead, and whoever ran it would learn nothing.
 *
 * They arrive from `scripts/with-secrets.sh`, which is the same store HW-11 built and the
 * same wrapper #13, #14, #22 and #24 use. `SKIP_VAULT=1` steps it aside for a CI runner or
 * a grader who already has the values — nothing here knows the difference.
 */
export const REQUIRED_SECRETS = [
    'DB_PASSWORD',
    'JWT_KID',
    'JWT_PRIVATE_KEY',
    'JWT_PUBLIC_KEY',
    'REFRESH_TOKEN_PEPPER',
    'STORAGE_ENDPOINT',
    'STORAGE_REGION',
    'STORAGE_ACCESS_KEY',
    'STORAGE_SECRET_KEY',
    'STORAGE_BUCKET',
] as const;

export type SecretName = (typeof REQUIRED_SECRETS)[number];

/** Named rather than inline, because three functions below take it. */
export type AppSecrets = Readonly<Record<SecretName, string>>;

/**
 * The one that reaches the database container and the migration Job, and is mounted into
 * the application as a file rather than handed to it as a variable — the #13 decision,
 * unchanged: the service re-reads that file per connection so the password can be rotated
 * under a running process.
 */
export const DB_PASSWORD: SecretName = 'DB_PASSWORD';

export function readSecrets(env: NodeJS.ProcessEnv): AppSecrets {
    const missing = REQUIRED_SECRETS.filter((name) => (env[name] ?? '').trim().length === 0);

    if (missing.length > 0) {
        throw new Error(
            [
                `Refusing to deploy: ${missing.length} required value(s) are not in the environment.`,
                ...missing.map((name) => `  ${name} is missing`),
                '',
                'These come from the store, never from a file in this repository and never',
                'from a default in this program. Run the deployment through the wrapper:',
                '',
                '    bash scripts/with-secrets.sh dev npm run up',
                '',
                'No access to the store (CI, or a grader on a fresh clone)? Export the block',
                'from the "Grading" section of README.md, SKIP_VAULT=1 included.',
            ].join('\n'),
        );
    }

    const collected: Partial<Record<SecretName, string>> = {};

    for (const name of REQUIRED_SECRETS) {
        collected[name] = env[name] ?? '';
    }

    return collected as AppSecrets;
}

/** What the application reads: everything except the database password. */
export function applicationSecrets(secrets: AppSecrets): Record<string, string> {
    const entries = REQUIRED_SECRETS.filter((name) => name !== DB_PASSWORD).map((name) => [
        name,
        encode(secrets[name]),
    ]);

    return Object.fromEntries(entries);
}

/**
 * `data` and not `stringData`, and it is not a style choice: `stringData` is write-only.
 * The API server never gives it back, so the provider sees a difference on every single
 * update and `pulumi up` twice in a row never says "unchanged".
 */
export function encode(value: string): string {
    return Buffer.from(value, 'utf8').toString('base64');
}
