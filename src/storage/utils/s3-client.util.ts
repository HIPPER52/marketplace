import { S3Client } from '@aws-sdk/client-s3';
import type { StorageEnv } from '../schemas/storage-env.schema';

/**
 * One client, built the same way wherever it is built.
 *
 * Three options and every one of them is load-bearing:
 *
 * - **`endpoint`** is `undefined` when the variable is empty, and that single line is the
 *   whole difference between a local MinIO and real AWS S3. The SDK resolves the real
 *   host from the region when nobody overrides it.
 * - **`forcePathStyle`** follows the endpoint. Virtual-host addressing puts the bucket in
 *   the hostname (`bucket.s3.amazonaws.com`), which an emulator on `127.0.0.1` has no way
 *   to answer; path style puts it in the path. AWS prefers the first, emulators need the
 *   second, so it is derived rather than configured.
 * - **`requestChecksumCalculation: 'WHEN_REQUIRED'`** is the one that costs an evening to
 *   find. Since late 2024 the JS SDK computes a CRC32 of the body by default — but a
 *   presigned URL is signed when there is no body yet, so what goes into the query is
 *   `x-amz-checksum-crc32=AAAAAA==`, the checksum of nothing. MinIO ignores it; other
 *   S3-compatible stores reject the upload on integrity, which reads as a signing bug and
 *   is not one.
 */
export function createS3Client(env: StorageEnv): S3Client {
    return new S3Client({
        region: env.STORAGE_REGION,
        endpoint: env.STORAGE_ENDPOINT,
        forcePathStyle: env.STORAGE_ENDPOINT !== undefined,
        credentials: {
            accessKeyId: env.STORAGE_ACCESS_KEY,
            secretAccessKey: env.STORAGE_SECRET_KEY,
        },
        requestChecksumCalculation: 'WHEN_REQUIRED',
    });
}
