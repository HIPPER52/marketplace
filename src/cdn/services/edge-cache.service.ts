import { CACHE_HEADER, CacheOutcome, EDGE_CACHE_ENTRIES } from '../constants/edge.constant';
import type { CachedObject, EdgeStats } from '../types/edge.types';

/**
 * A shared cache in front of a closed bucket. The local half of this assignment's CDN.
 *
 * ## What it is
 *
 * Thirty lines of "ask the store with our credentials, keep the answer, serve it with
 * `X-Cache`". That is the whole of **origin access control**: the public never reaches
 * the bucket, the cache does, and the bucket's only reader is an identity the public does
 * not have. CloudFront + OAC is the same sentence with a bucket policy instead of a
 * process — see README, "Files", which carries that policy.
 *
 * ## The part people get wrong
 *
 * **It caches what the origin says may be cached, and nothing else.** `Cache-Control` is
 * read off the object, not invented here, because that is what RFC 9111 says a shared
 * cache does and because inventing it is how a private answer ends up in a cache everyone
 * reads. The practical consequence is worth stating plainly: an object uploaded without
 * `Cache-Control` is never cached, every request is a MISS, and a `cache-hit=0` almost
 * always means the header was not set **at upload time**.
 *
 * ## What it deliberately does not have
 *
 * An invalidation endpoint. Not because it would be hard — this is a `Map` and a `delete`
 * would take one line — but because the point of the exercise is that at real scale you
 * cannot have one: the copies are in hundreds of machines that are not yours, the API
 * that asks them to forget is paid, rate-limited, irreversible, and does not reach the
 * browser cache or a corporate proxy at all. Content-addressed names are the answer, and
 * a `delete` here would quietly teach the opposite lesson.
 */
export class EdgeCache {
    readonly stats: EdgeStats = { hits: 0, misses: 0, uncacheable: 0 };

    private readonly entries = new Map<string, CachedObject>();

    constructor(
        private readonly origin: (key: string) => Promise<{
            body: Buffer;
            contentType: string | undefined;
            cacheControl: string | undefined;
        } | null>,
    ) {}

    /** What to send back for this key, with the header that says where it came from. */
    async serve(key: string): Promise<{
        status: number;
        body: Buffer;
        headers: Record<string, string>;
    }> {
        const held = this.entries.get(key);

        if (held !== undefined && held.expiresAt > Date.now()) {
            this.stats.hits += 1;
            // Re-inserting moves it to the end of the Map's insertion order, which is
            // what makes the eviction below least-recently-*used* rather than oldest.
            this.entries.delete(key);
            this.entries.set(key, held);

            return {
                status: 200,
                body: held.body,
                headers: {
                    'content-type': held.contentType,
                    'cache-control': held.cacheControl,
                    [CACHE_HEADER]: CacheOutcome.Hit,
                },
            };
        }

        const fresh = await this.origin(key);

        if (fresh === null) {
            return {
                status: 404,
                body: Buffer.from('not found'),
                headers: { 'content-type': 'text/plain', [CACHE_HEADER]: CacheOutcome.Miss },
            };
        }

        const cacheControl = fresh.cacheControl;
        const maxAge = cacheControl === undefined ? null : maxAgeOf(cacheControl);

        if (maxAge === null || cacheControl === undefined) {
            // The origin did not say this may be shared. A cache that stored it anyway
            // would be deciding on the origin's behalf, which is how a private response
            // ends up being served to somebody else.
            this.stats.uncacheable += 1;
        } else {
            this.remember(key, {
                body: fresh.body,
                contentType: fresh.contentType ?? 'application/octet-stream',
                cacheControl,
                expiresAt: Date.now() + maxAge * 1_000,
            });
        }

        this.stats.misses += 1;

        return {
            status: 200,
            body: fresh.body,
            headers: {
                'content-type': fresh.contentType ?? 'application/octet-stream',
                ...(fresh.cacheControl === undefined
                    ? {}
                    : { 'cache-control': fresh.cacheControl }),
                [CACHE_HEADER]: CacheOutcome.Miss,
            },
        };
    }

    private remember(key: string, object: CachedObject): void {
        if (this.entries.size >= EDGE_CACHE_ENTRIES) {
            const oldest = this.entries.keys().next().value;

            if (oldest !== undefined) {
                this.entries.delete(oldest);
            }
        }

        this.entries.set(key, object);
    }
}

/**
 * How long a shared cache may hold this, in seconds, or `null` for "it may not".
 *
 * `s-maxage` wins over `max-age` for a shared cache, and `private` or `no-store` end the
 * conversation — the three rules of RFC 9111 that a two-line parser gets wrong.
 */
export function maxAgeOf(cacheControl: string | undefined): number | null {
    if (cacheControl === undefined) {
        return null;
    }

    const directives = cacheControl.toLowerCase();

    if (directives.includes('no-store') || directives.includes('private')) {
        return null;
    }

    const shared = /s-maxage=(\d+)/.exec(directives);
    const plain = /max-age=(\d+)/.exec(directives);
    const seconds = Number((shared ?? plain)?.[1] ?? Number.NaN);

    return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}
