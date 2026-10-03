import { z } from 'zod';

/**
 * What the command-line tools need to reach Postgres.
 *
 * This is a second environment contract alongside src/config/schemas/env.schema.ts, and
 * deliberately so. The HTTP service takes a DATABASE_URL that carries no password plus a
 * password file it re-reads on every connection, because that is what lets ./rotate.sh
 * replace the password without a restart. A migration run is a process that lives for two
 * seconds; it has no connection to rotate, and the flat DB_* block is what a CI runner or
 * a grader can export by hand.
 *
 * Both shapes come out of the same store. scripts/with-secrets.sh is the one place that
 * turns one into the other — see its header.
 */
export const datasourceEnvSchema = z.object({
    DB_HOST: z.string().min(1, 'required: hostname of the Postgres server'),
    DB_PORT: z.coerce.number().int().positive().max(65535).default(5432),
    DB_USER: z.string().min(1, 'required: database role to connect as'),
    DB_PASSWORD: z.string().min(1, 'required: supplied by scripts/with-secrets.sh'),
    DB_NAME: z.string().min(1, 'required: database name'),
});

export type DatasourceEnv = z.infer<typeof datasourceEnvSchema>;

export function readDatasourceEnv(raw: NodeJS.ProcessEnv): DatasourceEnv {
    const result = datasourceEnvSchema.safeParse(raw);

    if (result.success) {
        return result.data;
    }

    const lines = result.error.issues.map((issue) => `  ${issue.path.join('.')}: ${issue.message}`);

    throw new Error(
        [
            `Cannot build a DataSource (${lines.length} problem(s)):`,
            ...lines,
            '',
            'These variables are not meant to be typed by hand. Every npm script that',
            'reaches the database runs through scripts/with-secrets.sh, which fills them',
            'in from the store. Running a command directly? Prefix it:',
            '',
            '    bash scripts/with-secrets.sh dev <command>',
            '',
            'No access to the store (CI, or a grader on a fresh clone)? Export the block',
            'from the "Grading" section of README.md, SKIP_VAULT=1 included.',
        ].join('\n'),
    );
}
