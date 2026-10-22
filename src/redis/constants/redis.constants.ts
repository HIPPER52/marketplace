/**
 * The cache instance: `maxmemory` with `allkeys-lru`. Anything here may vanish at any
 * moment, chosen by Redis from a sample of five — so nothing may be *only* here.
 */
export const REDIS_CACHE = Symbol('REDIS_CACHE');

/**
 * The queue instance: `noeviction`, AOF on. BullMQ's keys and session state, both of which
 * nobody is allowed to throw away.
 */
export const REDIS_QUEUE = Symbol('REDIS_QUEUE');
