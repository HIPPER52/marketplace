import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS_CACHE, REDIS_QUEUE } from '../constants/redis.constants';
import { quitQuietly } from '../utils/redis.util';

/**
 * Closes both connections when the application does.
 *
 * A separate provider because the things being closed are `ioredis` clients, and Nest
 * calls lifecycle hooks on the objects it holds — an `ioredis` instance has no
 * `onModuleDestroy`. Without this, `app.close()` resolves while two sockets are still
 * open and the E2E suite hangs on them rather than finishing.
 */
@Injectable()
export class RedisLifecycle implements OnModuleDestroy {
    constructor(
        @Inject(REDIS_CACHE) private readonly cache: Redis,
        @Inject(REDIS_QUEUE) private readonly queue: Redis,
    ) {}

    async onModuleDestroy(): Promise<void> {
        await quitQuietly(this.cache);
        await quitQuietly(this.queue);
    }
}
