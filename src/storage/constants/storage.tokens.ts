/**
 * The two things injected rather than imported.
 *
 * An `S3Client` is built from the environment and a bucket is a string, so neither can be
 * a class Nest resolves by type — the same arrangement `DATA_SOURCE` and the two Redis
 * connections already use here.
 */
export const STORAGE_CLIENT = Symbol('STORAGE_CLIENT');
export const STORAGE_BUCKET = Symbol('STORAGE_BUCKET');
