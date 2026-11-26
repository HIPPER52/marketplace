import { randomUUID } from 'node:crypto';
import { LOCK_POLL_MS, LOCK_TTL_MS } from '../constants/cache.constant';
import { lockKeyFor } from '../utils/cache-key.util';
import type { Scripted } from '../utils/script.util';

export type Role = 'leader' | 'follower' | 'fallback';

export interface Flight<T> {
    value: T;
    role: Role;
}

/**
 * One loader per key, however many readers arrive at once.
 *
 * ## The failure this exists for
 *
 * A popular key disappears — expired, evicted, or invalidated by a deploy. Every request
 * that arrives in the window between its disappearance and its replacement sees a miss,
 * and every one of them goes to the database. Fifty concurrent readers become fifty
 * identical queries. **None of those fifty has a bug**: each independently saw a miss and
 * honestly went to load the value, which is why this is not something code review finds.
 * The surge is not a cold-start problem either — a cold cache spreads its misses evenly.
 * It is the loss of *one popular key*, and the more popular the key the larger the crowd.
 *
 * ## The mechanism
 *
 * `SET lock:<key> <token> NX PX` — three parts and each does one job. `NX` means two
 * callers cannot both win. `PX` means a leader that dies does not hold the key's crowd
 * forever. The random token means the lock is released by comparing, not by deleting: a
 * bare `DEL` removes whichever lock happens to be there, and after an expiry that is
 * somebody else's.
 *
 * Losers do not queue on the lock — they poll the cache. The value is what they came for,
 * and it appears the moment the leader writes it, which is before the lock is released.
 *
 * ## What it does not promise
 *
 * If the leader is slower than `LOCK_TTL_MS`, a second leader starts and the database is
 * asked twice. If Redis is unreachable, everybody is a `fallback` and the database is
 * asked by everyone. Both are *correct* answers that cost money rather than wrong answers
 * that cost data — which is the whole reason a lock is acceptable here and would not be
 * acceptable around a business invariant.
 */
export class SingleFlight {
    constructor(private readonly redis: Scripted) {}

    /**
     * @param key    the cache key being filled; the lock is named after it
     * @param peek   reads the cache — a follower's way of finding out the leader is done
     * @param load   the expensive thing, run by at most one caller
     * @param store  publishes what `load` returned, before the lock is released
     */
    async run<T>(
        key: string,
        peek: () => Promise<T | null>,
        load: () => Promise<T>,
        store: (value: T) => Promise<void>,
    ): Promise<Flight<T>> {
        const lock = lockKeyFor(key);
        const token = randomUUID();
        const won = await this.redis.set(lock, token, 'PX', LOCK_TTL_MS, 'NX');

        if (won === 'OK') {
            try {
                const value = await load();
                // Published before the lock is released, so a follower that polls at the
                // instant of release still finds a value rather than an empty key.
                await store(value);

                return { value, role: 'leader' };
            } finally {
                await this.redis.compareAndDelete(lock, token);
            }
        }

        const followed = await this.follow(peek);

        if (followed !== null) {
            return { value: followed, role: 'follower' };
        }

        // The leader never published — it died, or it is slower than the lock's lifetime.
        // Going to the database is the honest answer: a degraded cache must degrade into
        // "slow", never into "wrong" and never into "waits forever".
        return { value: await load(), role: 'fallback' };
    }

    private async follow<T>(peek: () => Promise<T | null>): Promise<T | null> {
        const deadline = Date.now() + LOCK_TTL_MS;

        for (;;) {
            await sleep(LOCK_POLL_MS);

            const value = await peek();

            if (value !== null) {
                return value;
            }

            if (Date.now() >= deadline) {
                return null;
            }
        }
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
