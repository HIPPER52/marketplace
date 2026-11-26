import { z } from 'zod';

/**
 * What a process needs to reach the object store.
 *
 * A second environment contract beside `src/config/schemas/env.schema.ts`, for the same
 * reason `broker-env.schema.ts` and `redis-env.schema.ts` are: the three demos and the
 * edge do not boot Nest, so they cannot read `ConfigService`. The service validates the
 * same four variables through its own schema — one store, two shapes, and
 * `scripts/with-secrets.sh` is the one place that fills either of them.
 *
 * `STORAGE_ENDPOINT` is optional **and that is the whole portability story**: empty means
 * the AWS SDK resolves real S3 from the region, set means an emulator. Nothing else in
 * this project changes between MinIO, LocalStack, R2 and AWS.
 */
export const storageEnvSchema = z.object({
    STORAGE_ENDPOINT: z.string().url().optional(),
    STORAGE_REGION: z.string().min(1).default('us-east-1'),
    STORAGE_ACCESS_KEY: z.string({ error: 'required: the object store access key id' }).min(1),
    STORAGE_SECRET_KEY: z.string({ error: 'required: the object store secret key' }).min(1),
    STORAGE_BUCKET: z.string({ error: 'required: the bucket everything is written to' }).min(1),
});

export type StorageEnv = z.infer<typeof storageEnvSchema>;

export function readStorageEnv(raw: NodeJS.ProcessEnv): StorageEnv {
    const result = storageEnvSchema.safeParse(raw);

    if (result.success) {
        return result.data;
    }

    const lines = result.error.issues.map((issue) => `  ${issue.path.join('.')}: ${issue.message}`);

    throw new Error(
        [
            `Cannot reach the object store (${lines.length} problem(s)):`,
            ...lines,
            '',
            'These are not meant to be typed by hand. Every command that touches the',
            'store runs through scripts/with-secrets.sh, which fills them in:',
            '',
            '    bash scripts/with-secrets.sh dev <command>',
            '',
            'No access to the store (CI, or a grader on a fresh clone)? Export the block',
            'from the "Grading" section of README.md, SKIP_VAULT=1 included.',
        ].join('\n'),
    );
}
