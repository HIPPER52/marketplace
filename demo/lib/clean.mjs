import Redis from 'ioredis';

/**
 * Clears the state a previous run of the same demo left behind.
 *
 * The one piece that matters is #23's sliding window. It counts a caller's requests over
 * sixty seconds and keeps them in Redis, so two runs of `demo:metrics` inside a minute
 * share an allowance: the second one starts partway through its budget and begins
 * collecting `429`s, which are a correct answer, a new label set and therefore a new time
 * series — and the cardinality number moves for a reason that has nothing to do with the
 * route label.
 *
 * Running a demo three times in a row has to print the same thing three times. That is
 * only true if each run starts from the same place.
 */
const RATE_LIMIT_PREFIX = 'ratelimit:*';

export async function clearRateLimits() {
    const url = process.env.REDIS_QUEUE_URL;

    if (url === undefined || url === '') {
        return 0;
    }

    const redis = new Redis(url, { maxRetriesPerRequest: 2, lazyConnect: true });

    try {
        await redis.connect();

        let removed = 0;
        let cursor = '0';

        // SCAN and not KEYS: KEYS blocks a single-threaded server for the length of the
        // keyspace, and the habit is the problem rather than the size of this one.
        do {
            const [next, keys] = await redis.scan(cursor, 'MATCH', RATE_LIMIT_PREFIX, 'COUNT', 200);
            cursor = next;

            if (keys.length > 0) {
                removed += await redis.del(...keys);
            }
        } while (cursor !== '0');

        return removed;
    } finally {
        redis.disconnect();
    }
}
