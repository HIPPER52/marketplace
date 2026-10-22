import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { rateLimitKey } from '../../cache/utils/cache-key.util';
import type { Scripted } from '../../cache/utils/script.util';
import { RATE_LIMIT, RATE_WINDOW_MS } from '../constants/rate-limit.constant';

export interface Decision {
    allowed: boolean;
    remaining: number;
    /** Whole milliseconds until the oldest request in the window falls out of it. */
    retryAfterMs: number;
}

/**
 * A rate limit that two processes share.
 *
 * **The counter is in Redis, and that is the entire point.** An in-memory limiter is not a
 * smaller version of this one — it is a different limit per replica, so three pods enforce
 * three times what the configuration says, and no local test notices because locally there
 * is one pod. `@nestjs/throttler` counts in process memory by default; `demo:ratelimit`
 * raises two instances precisely so that an in-memory counter would show up as `allowed`
 * being twice the limit.
 *
 * The decision is one Lua script rather than read-then-write — see SLIDING_WINDOW for why
 * three commands leak exactly when the limit matters.
 */
export class SlidingWindowLimiter {
    private readonly logger = new Logger(SlidingWindowLimiter.name);

    constructor(
        private readonly redis: Scripted,
        readonly limit: number = RATE_LIMIT,
        readonly windowMs: number = RATE_WINDOW_MS,
    ) {}

    async take(client: string): Promise<Decision> {
        try {
            const [allowed, remaining, retryAfterMs] = await this.redis.slidingWindow(
                rateLimitKey(client),
                String(Date.now()),
                String(this.windowMs),
                String(this.limit),
                // Unique per request: the window is a set of events, and two requests in
                // the same millisecond are two events.
                `${Date.now()}:${randomUUID()}`,
            );

            return { allowed: allowed === 1, remaining, retryAfterMs };
        } catch (error: unknown) {
            // Fail open, deliberately. A limiter exists to protect the service from one
            // noisy client; a limiter that refuses everybody when its storage is
            // unreachable has become the outage it was there to prevent. The cost of
            // being wrong this way is a few extra requests, and it is logged.
            this.logger.warn(
                `rate limit storage unavailable, allowing: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );

            return { allowed: true, remaining: this.limit, retryAfterMs: 0 };
        }
    }
}
