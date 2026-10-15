import { z } from 'zod';
import { NODE_ENVS, NodeEnv } from '../constants/node-env.constant';
import { databaseUrlProblem } from '../utils/database-url.util';

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
