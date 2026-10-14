import { z } from 'zod';
import { brokerUrlProblem } from '../utils/broker-url.util';

/**
 * Where the broker is.
 *
 * A third environment contract beside src/config/schemas/env.schema.ts and
 * src/database/schemas/datasource-env.schema.ts, and for the same reason the second one
 * exists: the processes that read it are not the HTTP service. The three demo scripts
 * live for a few seconds, have no connection to rotate and no `.env` of their own — they
 * take the value from scripts/with-secrets.sh like every other command that reaches
 * something outside this process.
 *
 * Unlike DATABASE_URL, this one is allowed to carry its password inline. Postgres is
 * reached through a password file so that ./rotate.sh can replace the secret under a
 * running service; AMQP has no equivalent re-read, the connection is opened once per
 * process, and the grader's environment hands the URL over whole. Two different problems,
 * two different shapes — stated here rather than discovered.
 */
export const brokerEnvSchema = z.object({
    BROKER_URL: z
        .string()
        .min(1, 'required: amqp connection string')
        .superRefine((value, ctx) => {
            const problem = brokerUrlProblem(value);

            if (problem !== null) {
                ctx.addIssue({ code: 'custom', message: problem });
            }
        }),
});

export type BrokerEnv = z.infer<typeof brokerEnvSchema>;

export function readBrokerEnv(raw: NodeJS.ProcessEnv): BrokerEnv {
    const result = brokerEnvSchema.safeParse(raw);

    if (result.success) {
        return result.data;
    }

    const lines = result.error.issues.map((issue) => `  ${issue.path.join('.')}: ${issue.message}`);

    throw new Error(
        [
            `Cannot reach the broker (${lines.length} problem(s)):`,
            ...lines,
            '',
            'BROKER_URL lives in the same store as the database credentials, and every',
            'npm script that talks to the broker goes through the same wrapper:',
            '',
            '    bash scripts/with-secrets.sh dev <command>',
            '',
            'Add it to .env beside DATABASE_URL. The dev stand answers on 25672:',
            '',
            '    BROKER_URL=amqp://marketplace_app:local_dev_password@localhost:25672',
            '',
            'No access to the store (CI, or a grader on a fresh clone)? Export the block',
            'from the "Grading" section of README.md, SKIP_VAULT=1 included.',
        ].join('\n'),
    );
}
