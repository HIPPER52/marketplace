import Redis, { type RedisOptions } from 'ioredis';

/**
 * One connection, opened the same way everywhere.
 *
 * `maxRetriesPerRequest` is the option worth knowing. ioredis defaults it to 20, and when
 * the budget runs out a command rejects — which is right for a web request (fail fast, the
 * caller is waiting) and wrong for a BullMQ worker, whose whole job is to be there when
 * Redis comes back. BullMQ requires `null` for exactly that reason, so the workers pass it
 * and everybody else keeps the default.
 */
export function createRedis(url: string, options: RedisOptions = {}): Redis {
    return new Redis(url, {
        // A dead Redis should be loud rather than silently queueing commands in the client.
        enableOfflineQueue: true,
        lazyConnect: false,
        ...options,
    });
}

/** The option set a BullMQ Queue or Worker needs. */
export function blockingRedis(url: string): Redis {
    return createRedis(url, { maxRetriesPerRequest: null });
}

export async function quitQuietly(client: { quit(): Promise<unknown> } | null): Promise<void> {
    if (client === null) {
        return;
    }

    try {
        await client.quit();
    } catch {
        // Already gone. Nothing left to close, and nothing worth saying about it.
    }
}
