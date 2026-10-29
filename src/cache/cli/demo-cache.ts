import 'reflect-metadata';
import { Currency } from '../../common/constants/currency.constant';
import { emit, finish } from '../../common/utils/demo-report.util';
import type { Queryable } from '../../database/types/queryable.types';
import { ProductsRepository } from '../../products/repositories/products.repository';
import { evictionPolicy, openRedisStand } from '../../redis/utils/redis-stand.util';
import {
    CACHE_DEMO_CONCURRENT,
    CACHE_DEMO_PRODUCTS,
    CACHE_DEMO_WARM_READS,
    cacheDemoProductId,
} from '../constants/demo.constant';
import { ProductCardCache } from '../services/product-card-cache.service';
import { productCardKey } from '../utils/cache-key.util';

/**
 * What a cache buys, and what a crowd on one missing key costs without a lock.
 *
 *   npm run demo:cache
 *
 * Three facts, measured rather than asserted:
 *
 *   `ttl-distinct`  the keys were warmed by one loop and still expire at different
 *                   seconds, because every TTL carries jitter. Without it this number is
 *                   1, and every key warmed by a deploy would expire in the same second.
 *   `db-calls`      fifty simultaneous readers arrive on a key that has just disappeared
 *                   and Postgres is asked **once**. Forty-nine of them waited for the
 *                   fiftieth and then read the cache.
 *   `db-calls-warm` a hundred reads of a warm key cost nothing at all.
 *
 * None of those fifty readers has a bug. Each saw a miss and honestly went to load the
 * value, which is why a stampede is not something code review finds — it is a property of
 * the arrangement, and the fix has to be in the arrangement too.
 */

async function main(): Promise<void> {
    const stand = await openRedisStand();

    try {
        const products = new ProductsRepository(stand.dataSource);
        const cache = new ProductCardCache(stand.cache, products);

        // ---- the instance this is pointed at --------------------------------------------
        const { policy, maxmemory } = await evictionPolicy(stand.cache);
        console.log(`cache instance: maxmemory-policy=${policy} maxmemory=${maxmemory}`);

        // ---- fixture: a catalogue the run owns -------------------------------------------
        const ids = Array.from({ length: CACHE_DEMO_PRODUCTS }, (_, i) => cacheDemoProductId(i));
        await seed(stand.dataSource, ids);
        await stand.cache.del(...ids.map(productCardKey));

        // ---- warm every key, then look at when they expire ---------------------------------
        for (const id of ids) {
            await cache.read(id);
        }

        const ttls = await Promise.all(ids.map((id) => stand.cache.ttl(productCardKey(id))));
        const warmed = ttls.filter((ttl) => ttl > 0).length;
        const distinct = new Set(ttls.filter((ttl) => ttl > 0)).size;

        console.log(
            `warmed ${warmed} keys; TTLs span ${Math.min(...ttls)}..${Math.max(...ttls)} s`,
        );

        // ---- the stampede ------------------------------------------------------------------
        // One key disappears — expired, evicted by the LRU, or dropped by a deploy. The
        // cause does not matter; what matters is that it was popular.
        const hot = ids[0] ?? '';
        await stand.cache.del(productCardKey(hot));

        const before = products.reads.cards;
        const flights = await Promise.all(
            Array.from({ length: CACHE_DEMO_CONCURRENT }, () => cache.read(hot)),
        );
        const dbCalls = products.reads.cards - before;

        const roles = flights.reduce<Record<string, number>>((seen, flight) => {
            seen[flight.source] = (seen[flight.source] ?? 0) + 1;
            return seen;
        }, {});
        console.log(
            `\n${CACHE_DEMO_CONCURRENT} simultaneous readers on a key that had just vanished:`,
        );
        console.log(
            `  roles: ${Object.entries(roles)
                .map(([k, v]) => `${k}=${v}`)
                .join(' ')}`,
        );

        // ---- and now that it is warm again ---------------------------------------------------
        const beforeWarm = products.reads.cards;
        for (let i = 0; i < CACHE_DEMO_WARM_READS; i += 1) {
            await cache.read(hot);
        }
        const dbCallsWarm = products.reads.cards - beforeWarm;

        emit({
            'cache-lru': policy !== 'noeviction' ? 1 : 0,
            'cache-maxmemory': maxmemory > 0 ? 1 : 0,
            warmed,
            'ttl-distinct': distinct,
            concurrent: CACHE_DEMO_CONCURRENT,
            'db-calls': dbCalls,
            'db-calls-warm': dbCallsWarm,
        });

        // ---- the invariants --------------------------------------------------------------------
        const failures: string[] = [];

        if (policy === 'noeviction' || maxmemory === 0) {
            failures.push(
                `the cache instance answers maxmemory-policy=${policy} maxmemory=${maxmemory}; ` +
                    'a cache on the stock configuration does not degrade, it starts refusing ' +
                    'writes with OOM',
            );
        }

        if (warmed < 50) {
            failures.push(`${warmed} keys were warmed, which is too few to say anything`);
        }

        if (distinct < 5) {
            failures.push(
                `${distinct} distinct expiry second(s) across ${warmed} keys — without ` +
                    'jitter a batch warmed together expires together',
            );
        }

        if (dbCalls !== 1) {
            failures.push(
                `${CACHE_DEMO_CONCURRENT} readers caused ${dbCalls} database call(s); the ` +
                    'single-flight lock is meant to make that exactly one',
            );
        }

        if (dbCallsWarm !== 0) {
            failures.push(
                `${CACHE_DEMO_WARM_READS} reads of a warm key cost ${dbCallsWarm} database ` +
                    'call(s) — the cache is not being read',
            );
        }

        finish(
            failures,
            `${CACHE_DEMO_WARM_READS} reads of a warm card cost nothing, and ` +
                `${CACHE_DEMO_CONCURRENT} readers arriving on a missing one cost a single\n` +
                `query. ${warmed} keys warmed by one loop expire across ${distinct} different ` +
                'seconds, which is\nwhat keeps the next stampede from being all of them at once.',
        );
    } finally {
        await stand.close();
    }
}

/** Deterministic rows, re-stocked on every run. */
async function seed(dataSource: Queryable, ids: string[]): Promise<void> {
    await dataSource.query(
        `INSERT INTO products (id, title, description, price_cents, currency, in_stock)
         SELECT id, 'Cache demo item ' || ordinality, 'Owned by demo:cache.', 1000, $2, 100
           FROM unnest($1::uuid[]) WITH ORDINALITY AS t(id, ordinality)
         ON CONFLICT (id) DO UPDATE SET in_stock = EXCLUDED.in_stock`,
        [ids, Currency.UAH],
    );
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
