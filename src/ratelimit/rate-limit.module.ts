import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import type { Scripted } from '../cache/utils/script.util';
import { REDIS_QUEUE } from '../redis/constants/redis.constants';
import { RATE_LIMITER } from './constants/rate-limit.token';
import { RateLimitGuard } from './guards/rate-limit.guard';
import { SlidingWindowLimiter } from './services/sliding-window.service';

/**
 * The limit, and the guard that spends it.
 *
 * On the `noeviction` instance rather than the cache: an evicted counter does not slow the
 * limiter down, it silently raises the limit — the window resets and the client that was
 * being held back is let through. A limit whose storage is allowed to forget is not a
 * limit, and the instance that is forbidden to forget already exists for the queue.
 */
@Module({
    providers: [
        {
            provide: RATE_LIMITER,
            inject: [REDIS_QUEUE],
            useFactory: (redis: Scripted) => new SlidingWindowLimiter(redis),
        },
        { provide: APP_GUARD, useClass: RateLimitGuard },
    ],
})
export class RateLimitModule {}
