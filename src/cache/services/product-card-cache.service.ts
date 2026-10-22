import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ProductCardRow } from '../../products/repositories/products.repository';
import { ProductsRepository } from '../../products/repositories/products.repository';
import { REDIS_CACHE } from '../../redis/constants/redis.constants';
import { CARD_MISS_TTL_SEC, CARD_TTL_JITTER_SEC, CARD_TTL_SEC } from '../constants/cache.constant';
import { productCardKey } from '../utils/cache-key.util';
import type { Scripted } from '../utils/script.util';
import { SingleFlight } from './single-flight.service';

/**
 * What is stored under a card key.
 *
 * A tagged entry rather than "the card, or nothing": `null` in a cache is ambiguous — it
 * means both "not cached" and "cached as absent" — and the difference is the one that
 * decides whether a reader waits or goes to the database.
 */
type CardEntry = { found: true; card: ProductCardRow } | { found: false };

export interface CardRead {
    card: ProductCardRow | null;
    /** `hit` never touched Postgres; the rest are the three ways a miss can end. */
    source: 'hit' | 'leader' | 'follower' | 'fallback';
}

/**
 * Cache-aside over the most expensive read in the catalogue.
 *
 * Cache-aside — the application writes the cache after a miss — rather than read-through,
 * because the cache is this code's decision rather than a library's, and rather than
 * write-through because the cost of being five minutes stale about "units sold" is
 * nothing and the cost of a synchronous double write on every order is real.
 *
 * **A TTL is set on every write, always.** Not because invalidation is impossible here —
 * placing an order queues a refresh, and that is genuinely better than waiting — but
 * because the first path somebody forgets to invalidate would otherwise leave a key wrong
 * forever. Explicit invalidation is an optimisation layered on top of an expiry; it is
 * never a replacement for one.
 *
 * **Every failure here is swallowed.** A cache that throws is worse than no cache: the
 * stock Redis configuration answers `OOM command not allowed` once memory runs out, and an
 * unguarded `set()` turns that into a 500 on a customer's request. Being unable to
 * remember something must never become being unable to answer.
 */
@Injectable()
export class ProductCardCache {
    /** What the demo reports. `hits + misses` is every call that came through here. */
    readonly tally = { hits: 0, misses: 0, leaders: 0, followers: 0, fallbacks: 0, errors: 0 };

    private readonly logger = new Logger(ProductCardCache.name);
    private readonly flight: SingleFlight;

    constructor(
        @Inject(REDIS_CACHE) private readonly redis: Scripted,
        private readonly products: ProductsRepository,
    ) {
        this.flight = new SingleFlight(redis);
    }

    async read(productId: string): Promise<CardRead> {
        const cached = await this.peek(productId);

        if (cached !== null) {
            this.tally.hits += 1;

            return { card: cached.found ? cached.card : null, source: 'hit' };
        }

        this.tally.misses += 1;

        const { value, role } = await this.flight.run<CardEntry>(
            productCardKey(productId),
            () => this.peek(productId),
            () => this.load(productId),
            (entry) => this.store(productId, entry),
        );

        this.tally[`${role}s`] += 1;

        return { card: value.found ? value.card : null, source: role };
    }

    /**
     * Recomputes a card and publishes it, without reading the cache first.
     *
     * What the queue worker calls after an order moved the stock. It writes rather than
     * deletes: deleting leaves the next reader to pay for the reload, and the whole point
     * of doing this out of band is that somebody has already paid.
     */
    async refresh(productId: string): Promise<ProductCardRow | null> {
        const entry = await this.load(productId);
        await this.store(productId, entry);

        return entry.found ? entry.card : null;
    }

    /** Seconds a freshly written card will live. Jittered — see CARD_TTL_SEC. */
    ttlFor(entry: CardEntry): number {
        return entry.found
            ? CARD_TTL_SEC + Math.floor(Math.random() * CARD_TTL_JITTER_SEC)
            : CARD_MISS_TTL_SEC;
    }

    private async load(productId: string): Promise<CardEntry> {
        const card = await this.products.cardOf(productId);

        return card === null ? { found: false } : { found: true, card };
    }

    private async peek(productId: string): Promise<CardEntry | null> {
        try {
            const raw = await this.redis.get(productCardKey(productId));

            return raw === null ? null : (JSON.parse(raw) as CardEntry);
        } catch (error: unknown) {
            // Unreachable Redis, or a value somebody else wrote in another shape. Either
            // way the answer is "not cached", and Postgres still knows.
            this.note(error);

            return null;
        }
    }

    private async store(productId: string, entry: CardEntry): Promise<void> {
        try {
            await this.redis.set(
                productCardKey(productId),
                JSON.stringify(entry),
                'EX',
                this.ttlFor(entry),
            );
        } catch (error: unknown) {
            this.note(error);
        }
    }

    private note(error: unknown): void {
        this.tally.errors += 1;
        this.logger.warn(
            `cache unavailable, serving from Postgres: ${
                error instanceof Error ? error.message : String(error)
            }`,
        );
    }
}
