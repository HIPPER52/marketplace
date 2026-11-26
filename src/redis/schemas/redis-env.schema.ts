import { z } from 'zod';
import { redisUrlProblem } from '../utils/redis-url.util';

function url(label: string) {
    return z
        .string()
        .min(1, `required: ${label}`)
        .superRefine((value, ctx) => {
            const problem = redisUrlProblem(value);

            if (problem !== null) {
                ctx.addIssue({ code: 'custom', message: problem });
            }
        });
}

/**
 * Where the two Redis instances are.
 *
 * **Two**, and the second is not a preference. A cache has to be allowed to throw things
 * away — `maxmemory` plus `allkeys-lru` — and BullMQ's documentation says a queue "cannot
 * work properly if Redis evicts keys arbitrarily" and insists on `noeviction`. Those are
 * settings of a *process*, not of a database, so `SELECT 1` does not separate them: one
 * instance cannot be both. Session state lives with the queue, because a session an LRU
 * decided to drop is a logout nobody can reproduce.
 *
 * Read by the processes that talk to Redis — the service, the card worker and the four
 * demos — exactly as `datasource-env.schema.ts` is read by the ones that talk to Postgres.
 */
export const redisEnvSchema = z.object({
    REDIS_URL: url('the cache instance, e.g. redis://localhost:26379'),
    REDIS_QUEUE_URL: url('the queue instance, e.g. redis://localhost:26380'),
});

export type RedisEnv = z.infer<typeof redisEnvSchema>;

export function readRedisEnv(raw: NodeJS.ProcessEnv): RedisEnv {
    const result = redisEnvSchema.safeParse(raw);

    if (result.success) {
        return result.data;
    }

    const lines = result.error.issues.map((issue) => `  ${issue.path.join('.')}: ${issue.message}`);

    throw new Error(
        [
            `Cannot reach Redis (${lines.length} problem(s)):`,
            ...lines,
            '',
            'Both addresses live in the same store as the database credentials, and every',
            'npm script that talks to Redis goes through the same wrapper:',
            '',
            '    bash scripts/with-secrets.sh dev <command>',
            '',
            'Add them to .env beside DATABASE_URL. The dev stand answers on 26379 / 26380:',
            '',
            '    REDIS_URL=redis://localhost:26379',
            '    REDIS_QUEUE_URL=redis://localhost:26380',
            '',
            'No access to the store (CI, or a grader on a fresh clone)? Export the block',
            'from the "Grading" section of README.md, SKIP_VAULT=1 included.',
        ].join('\n'),
    );
}
