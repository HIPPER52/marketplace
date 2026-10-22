import { z } from 'zod';
import { redisUrlProblem } from '../../redis/utils/redis-url.util';
import { NODE_ENVS, NodeEnv } from '../constants/node-env.constant';
import { databaseUrlProblem } from '../utils/database-url.util';

function redisUrl(label: string) {
    return z
        .string()
        .min(1, label)
        .superRefine((value, ctx) => {
            const problem = redisUrlProblem(value);

            if (problem !== null) {
                ctx.addIssue({ code: 'custom', message: problem });
            }
        });
}

export const envSchema = z.object({
    NODE_ENV: z.enum(NODE_ENVS).default(NodeEnv.Development),
    PORT: z.coerce.number().int().positive().max(65535).default(3000),

    DATABASE_URL: z
        .string()
        .min(1, 'required: postgres connection string')
        .superRefine((value, ctx) => {
            const problem = databaseUrlProblem(value);

            if (problem !== null) {
                ctx.addIssue({ code: 'custom', message: problem });
            }
        }),

    /**
     * The two Redis instances, both required.
     *
     * Required and not optional, unlike the broker `order.placed` goes to: this service
     * reads through a cache, counts its rate limit and remembers who came between requests,
     * and all three of those are request-path behaviour rather than a side channel. A
     * deployment without them is not a degraded deployment, it is a different one.
     *
     * Two variables because they are two processes with incompatible eviction policies —
     * see redis/schemas/redis-env.schema.ts.
     */
    REDIS_URL: redisUrl('required: the cache instance'),
    REDIS_QUEUE_URL: redisUrl('required: the queue instance'),

    DB_PASSWORD_FILE: z.string().min(1).default('./secrets/db_password'),

    DB_POOL_MAX: z.coerce.number().int().positive().max(100).default(10),
    LOG_LEVEL: z.enum(['error', 'warn', 'log', 'debug', 'verbose']).default('log'),
});

export type Env = z.infer<typeof envSchema>;

export function validate(raw: Record<string, unknown>): Env {
    const result = envSchema.safeParse(raw);

    if (result.success) {
        return result.data;
    }

    const lines = result.error.issues.map((issue) => {
        const name = issue.path.join('.') || '(root)';
        return `  ${name}: ${issue.message}`;
    });

    throw new Error(
        [
            `Invalid environment configuration (${lines.length} problem(s)):`,
            ...lines,
            '',
            'Every variable is documented in .env.example. Copy it to .env and fill it in.',
        ].join('\n'),
    );
}
