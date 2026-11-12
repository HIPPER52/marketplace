/**
 * The object store, as far as a suite that never uploads is concerned.
 *
 * The four variables are required with no defaults, so the application refuses to start
 * without them — which is the behaviour being relied on rather than worked around. The
 * endpoint points at a port nothing listens on, for the same reason the suites point
 * `BROKER_URL` at one: a developer whose stand has a MinIO must not have a test run
 * writing objects into it while CI writes none. Any test that did upload would fail
 * loudly here rather than quietly somewhere real.
 */
export function seedStorageEnv(): void {
    process.env.STORAGE_ENDPOINT = 'http://127.0.0.1:1';
    process.env.STORAGE_REGION = 'us-east-1';
    process.env.STORAGE_ACCESS_KEY = 'test';
    process.env.STORAGE_SECRET_KEY = 'test-secret';
    process.env.STORAGE_BUCKET = 'test-bucket';
}
