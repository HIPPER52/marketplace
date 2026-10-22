import { GenericContainer, type StartedTestContainer } from 'testcontainers';

export interface RedisHandle {
    /** The cache instance's URL, as the service's environment expects it. */
    cacheUrl: string;
    /** The queue instance's URL. */
    queueUrl: string;
    stop(): Promise<void>;
}

/**
 * A Redis the suite owns, raised the same way the Postgres is.
 *
 * `redis:8-alpine` — the version `docker-compose.yml` runs, for the reason the Postgres
 * container matches too: testing against another major is a mock's lie with a version
 * number on it.
 *
 * **One container, two logical databases**, where the stand has two containers. The stand
 * needs two because `maxmemory-policy` belongs to a process and the cache's `allkeys-lru`
 * and the queue's `noeviction` cannot both be it. A test sets no memory limit and evicts
 * nothing, so the thing the second container exists for does not arise here — and the
 * claim that the two instances really are configured differently is made by `demo:cache`
 * and `demo:queue`, which read the policy off the live servers.
 */
export async function startRedis(label: string): Promise<RedisHandle> {
    const startedAt = Date.now();

    const started: StartedTestContainer = await new GenericContainer('redis:8-alpine')
        // No snapshotting: this instance lives for the length of one suite.
        .withCommand(['redis-server', '--save', ''])
        .withExposedPorts(6379)
        .start();

    const base = `redis://${started.getHost()}:${started.getMappedPort(6379)}`;
    console.log(`[testkit] redis:8-alpine ${label} ready in ${Date.now() - startedAt} ms`);

    return {
        cacheUrl: `${base}/0`,
        queueUrl: `${base}/1`,
        stop: () => started.stop().then(() => undefined),
    };
}
