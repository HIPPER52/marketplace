import { createHash } from 'node:crypto';

/**
 * The catalogue `demo:cache` owns.
 *
 * Its own products rather than whatever `npm run seed` inserted, for two reasons: the demo
 * has to warm at least fifty keys and a seeded catalogue is smaller than that, and spending
 * another demo's stock would make two runs interfere. Ids are derived, so every run on
 * every machine means the same rows — the same idiom db/seed.sql uses.
 */
export function cacheDemoProductId(index: number): string {
    const digest = createHash('md5').update(`marketplace:cache-demo:${index}`).digest('hex');

    return [
        digest.slice(0, 8),
        digest.slice(8, 12),
        digest.slice(12, 16),
        digest.slice(16, 20),
        digest.slice(20, 32),
    ].join('-');
}

export const CACHE_DEMO_PRODUCTS = 60;

/** How many readers arrive at once on a key that has just vanished. */
export const CACHE_DEMO_CONCURRENT = 50;

/** Reads of an already-warm key, to show the cache is actually being used. */
export const CACHE_DEMO_WARM_READS = 100;
