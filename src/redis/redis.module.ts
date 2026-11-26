import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { COMPARE_AND_DELETE } from '../cache/constants/lua.constant';
import { defineScript, type Scripted } from '../cache/utils/script.util';
import type { Env } from '../config/schemas/env.schema';
import { SLIDING_WINDOW } from '../ratelimit/constants/lua.constant';
import { REDIS_CACHE, REDIS_QUEUE } from './constants/redis.constants';
import { RedisLifecycle } from './services/redis-lifecycle.service';
import { createRedis } from './utils/redis.util';

/**
 * The two connections, and the Lua that rides on them.
 *
 * Global because four unrelated concerns need one of the two — the card cache and its
 * single-flight lock on one, BullMQ, session state and the rate limiter's window on the
 * other — and threading an import of this module through all of them would say nothing
 * except that they all talk to Redis.
 *
 * The scripts are attached here rather than where they are used, so that a connection
 * handed to anybody is already able to run them and no caller has to remember to register
 * one first.
 */
@Global()
@Module({
    providers: [
        {
            provide: REDIS_CACHE,
            inject: [ConfigService],
            useFactory: (config: ConfigService<Env, true>): Scripted => {
                const client = createRedis(config.get('REDIS_URL', { infer: true })) as Scripted;
                defineScript(client, 'compareAndDelete', 1, COMPARE_AND_DELETE);

                return client;
            },
        },
        {
            provide: REDIS_QUEUE,
            inject: [ConfigService],
            useFactory: (config: ConfigService<Env, true>): Scripted => {
                const client = createRedis(
                    config.get('REDIS_QUEUE_URL', { infer: true }),
                ) as Scripted;
                defineScript(client, 'slidingWindow', 1, SLIDING_WINDOW);

                return client;
            },
        },
        RedisLifecycle,
    ],
    exports: [REDIS_CACHE, REDIS_QUEUE],
})
export class RedisModule {}
