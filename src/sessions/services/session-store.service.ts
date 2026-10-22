import { Inject, Injectable, Logger } from '@nestjs/common';
import { sessionKey } from '../../cache/utils/cache-key.util';
import type { Scripted } from '../../cache/utils/script.util';
import { REDIS_QUEUE } from '../../redis/constants/redis.constants';
import { SESSION_TTL_SEC } from '../constants/session.constant';

export interface Touch {
    sessionId: string;
    /** How many requests this session has made, this one included. */
    requests: number;
    /** Seconds left before the touch; -2 when the key did not exist. */
    ttlBefore: number;
    ttlAfter: number;
}

/**
 * Who came, between requests.
 *
 * ## Why this is state and not a header
 *
 * `X-User-Id` from #18 is a claim the client makes, and it says nothing about what
 * happened on the previous request. A session is the place where "the same person is still
 * here" lives — and it has to live somewhere that survives a restart and is shared by
 * every replica, which rules out the obvious wrong answer of a `Map` in the process. The
 * key is the claim today; #24 replaces the claim with something verified and this store
 * does not change.
 *
 * ## Why not on the cache instance
 *
 * Because the cache instance is configured to throw things away. `allkeys-lru` picks its
 * victim from a sample of five, with no regard for what the key means, so a busy minute
 * would log people out at random — an incident with no reproduction and no pattern. A
 * session belongs on an instance that is forbidden to evict, which is the one BullMQ
 * already demands.
 *
 * ## Rolling the TTL
 *
 * A `MULTI` rather than one command, because this session is a hash and the counter has to
 * move with it. For a session held as a single string `GETEX key EX n` does read and renew
 * in one call, and Redis 7.4 added `HEXPIRE` for a TTL on an individual hash field — both
 * are the right tool for a shape this one does not have. What matters is that the renewal
 * is not a separate round trip that can be skipped on an error path.
 */
@Injectable()
export class SessionStore {
    private readonly logger = new Logger(SessionStore.name);

    constructor(@Inject(REDIS_QUEUE) private readonly redis: Scripted) {}

    /** Records the visit and pushes the expiry back. Returns what the demo measures. */
    async touch(sessionId: string, ttlSec: number = SESSION_TTL_SEC): Promise<Touch | null> {
        const key = sessionKey(sessionId);

        try {
            const ttlBefore = await this.redis.ttl(key);
            const now = new Date().toISOString();

            const replies = await this.redis
                .multi()
                .hincrby(key, 'requests', 1)
                .hset(key, { lastSeenAt: now })
                .hsetnx(key, 'firstSeenAt', now)
                .expire(key, ttlSec)
                .exec();

            const requests = Number(replies?.[0]?.[1] ?? 0);
            const ttlAfter = await this.redis.ttl(key);

            return { sessionId, requests, ttlBefore, ttlAfter };
        } catch (error: unknown) {
            // A session store that throws turns "I could not remember you" into "your
            // request failed". The caller is anonymous for this request and that is all.
            this.logger.warn(
                `session store unavailable: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );

            return null;
        }
    }

    async read(sessionId: string): Promise<Record<string, string> | null> {
        const found = await this.redis.hgetall(sessionKey(sessionId));

        return Object.keys(found).length === 0 ? null : found;
    }

    ttl(sessionId: string): Promise<number> {
        return this.redis.ttl(sessionKey(sessionId));
    }

    async forget(sessionId: string): Promise<void> {
        await this.redis.del(sessionKey(sessionId));
    }
}
