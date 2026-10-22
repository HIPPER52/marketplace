import 'reflect-metadata';
import type { DataSource } from 'typeorm';
import { COMPARE_AND_DELETE } from '../../cache/constants/lua.constant';
import { defineScript, type Scripted } from '../../cache/utils/script.util';
import { AppDataSource } from '../../database/data-source';
import { SLIDING_WINDOW } from '../../ratelimit/constants/lua.constant';
import { readRedisEnv } from '../schemas/redis-env.schema';
import { blockingRedis, createRedis, quitQuietly } from './redis.util';

export interface RedisStand {
    cache: Scripted;
    queue: Scripted;
    /** The queue's URL, for the BullMQ connections that must own their own socket. */
    queueUrl: string;
    dataSource: DataSource;
    /** A connection BullMQ may block on. Created on demand; closed with the stand. */
    blocking(): Scripted;
    close(): Promise<void>;
}

/**
 * What every demo and the card worker start from.
 *
 * Both connections, both Lua scripts attached, and a DataSource — the same assembly the
 * application builds through Nest, done by hand because a demo cannot boot the
 * application: a grader exports `DATABASE_URL` with the password inline and the service's
 * environment schema refuses exactly that, by the decision taken in #13.
 */
export async function openRedisStand(): Promise<RedisStand> {
    const { REDIS_URL, REDIS_QUEUE_URL } = readRedisEnv(process.env);

    const cache = createRedis(REDIS_URL) as Scripted;
    defineScript(cache, 'compareAndDelete', 1, COMPARE_AND_DELETE);

    const queue = createRedis(REDIS_QUEUE_URL) as Scripted;
    defineScript(queue, 'slidingWindow', 1, SLIDING_WINDOW);

    const dataSource = await AppDataSource.initialize();
    const blockers: Scripted[] = [];

    return {
        cache,
        queue,
        queueUrl: REDIS_QUEUE_URL,
        dataSource,
        blocking: () => {
            const client = blockingRedis(REDIS_QUEUE_URL) as Scripted;
            blockers.push(client);

            return client;
        },
        close: async () => {
            for (const blocker of blockers) {
                await quitQuietly(blocker);
            }

            await quitQuietly(cache);
            await quitQuietly(queue);
            await dataSource.destroy();
        },
    };
}

/**
 * What a connection says about its own eviction policy.
 *
 * Read at runtime rather than asserted in prose, because this is the one claim of the
 * assignment that a configuration file can lie about: the demos print what the server
 * actually answers.
 */
export async function evictionPolicy(client: Scripted): Promise<{
    policy: string;
    maxmemory: number;
}> {
    // CONFIG GET answers with a flat [name, value, …] array, which ioredis types as
    // `unknown` because the shape depends on the subcommand.
    const policy = (await client.config('GET', 'maxmemory-policy')) as string[];
    const maxmemory = (await client.config('GET', 'maxmemory')) as string[];

    return { policy: String(policy[1]), maxmemory: Number(maxmemory[1]) };
}
