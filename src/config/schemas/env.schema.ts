import { z } from 'zod';
import { pemProblem } from '../../auth/utils/pem.util';
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

function pem(kind: 'PRIVATE' | 'PUBLIC') {
    const required = `required: base64 of the ${kind.toLowerCase()} key PEM — npm run keygen`;

    // `error` as well as `.min()`: the second covers an empty string, the first covers the
    // variable not being there at all. Without it a missing key reports zod's own
    // "expected string, received undefined", which tells somebody who forgot to export a
    // secret nothing about which secret or where to get one.
    return z
        .string({ error: required })
        .min(1, required)
        .superRefine((value, ctx) => {
            const problem = pemProblem(value, kind);

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

    /**
     * The signing key, its public half, the id that names the pair, and the pepper the
     * refresh-token hashes are keyed with.
     *
     * **Four required variables with no defaults, and the absence of a default is the
     * point.** A default here is a key written into this repository, and a key written
     * into a repository is the ability to sign a token for anybody — no database access
     * needed, no password guessed, no network reached. The cost of a leaked DATABASE_URL
     * is access to a database somebody still has to be inside the network to use; the cost
     * of a leaked signing key is becoming any user of this service.
     *
     * So the service refuses to start without them, by name. That refusal happens here,
     * while `app.module.ts` is being evaluated — before NestFactory, before the pool, and
     * therefore before anything can fail with a connection error that says nothing about
     * the missing secret.
     */
    JWT_KID: z
        .string({ error: 'required: the id of the signing key pair, e.g. dev-2026-10' })
        .min(1, 'required: the id of the signing key pair, e.g. dev-2026-10'),
    JWT_PRIVATE_KEY: pem('PRIVATE'),
    JWT_PUBLIC_KEY: pem('PUBLIC'),
    REFRESH_TOKEN_PEPPER: z
        .string({
            error: 'required: at least 16 characters of secret, used to HMAC refresh tokens',
        })
        .min(16, 'required: at least 16 characters of secret, used to HMAC refresh tokens'),

    /**
     * The object store.
     *
     * `STORAGE_ENDPOINT` is **optional, and that is the portability story**: empty means
     * the SDK resolves real AWS S3 from the region, set means an emulator. Nothing else
     * in this project changes between MinIO, LocalStack, Cloudflare R2 and AWS.
     *
     * The other three are required and carry no defaults, for the same reason the signing
     * key does not: an access key to the store is the right to read and write every file
     * there is, and a default would be that right committed to this repository.
     */
    STORAGE_ENDPOINT: z.string().url().optional(),
    STORAGE_REGION: z.string().min(1).default('us-east-1'),
    STORAGE_ACCESS_KEY: z
        .string({ error: 'required: the object store access key id' })
        .min(1, 'required: the object store access key id'),
    STORAGE_SECRET_KEY: z
        .string({ error: 'required: the object store secret key' })
        .min(1, 'required: the object store secret key'),
    STORAGE_BUCKET: z
        .string({ error: 'required: the bucket everything is written to' })
        .min(1, 'required: the bucket everything is written to'),

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
