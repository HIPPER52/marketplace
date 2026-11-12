/**
 * The header this edge answers with, and the two values it uses.
 *
 * `X-Cache: HIT | MISS` is what a local edge calls it; CloudFront writes
 * `X-Cache: Hit from cloudfront`. A demo prints `cache-hit=1` rather than the header, so
 * the same invariant reads the same either way.
 */
export const CACHE_HEADER = 'x-cache';

export const CacheOutcome = {
    Hit: 'HIT',
    Miss: 'MISS',
} as const;

export type CacheOutcome = (typeof CacheOutcome)[keyof typeof CacheOutcome];

/** The default port, overridden by the demo so two runs cannot collide. */
export const EDGE_PORT = 29080;

/**
 * How many objects one edge holds.
 *
 * Small and in the process, which is the honest shape of this: a real CDN is hundreds of
 * nodes with their own storage, and the only property being demonstrated here is the one
 * that matters — **the copy is somewhere you cannot reach.** Stated rather than
 * discovered; see README, "What this edge is not".
 */
export const EDGE_CACHE_ENTRIES = 256;
