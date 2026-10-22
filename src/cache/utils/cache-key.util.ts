/**
 * Key names, in one place.
 *
 * A cache key is a contract between the writer and every reader, including the one written
 * next year. Built by a function so that a rename is one edit and `KEYS product:card:*`
 * typed into redis-cli still finds everything — and so that nothing composes a key by
 * string concatenation at a call site, which is how two spellings of the same key end up
 * in one codebase.
 */
export const productCardKey = (productId: string): string => `product:card:${productId}`;

/** The lock that guards a key, named after it. `lock:` is a namespace, not a prefix. */
export const lockKeyFor = (key: string): string => `lock:${key}`;

/** Where a request's window lives, per client. */
export const rateLimitKey = (client: string): string => `ratelimit:${client}`;

/** Who came, between requests. */
export const sessionKey = (sessionId: string): string => `sess:${sessionId}`;
