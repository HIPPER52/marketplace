/**
 * How long a product card is allowed to be wrong, and by how much that may vary.
 *
 * A cache is a deliberate agreement about stale data, and these two numbers are the whole
 * agreement: five minutes of staleness, spread over a further minute.
 *
 * **The jitter is not decoration.** Keys warmed by one loop — a deploy, a crawler, a
 * cache rebuilt after a restart — are written within milliseconds of each other, and with
 * a fixed TTL they expire within milliseconds of each other too. The cache then empties
 * all at once and every one of those reads arrives at Postgres in the same second. The
 * lock in SingleFlight protects *one* key from a crowd; the jitter protects the database
 * from the keys agreeing on a time. It costs nothing, which is the rare case where the
 * right answer is also free.
 */
export const CARD_TTL_SEC = 300;

/** Added to the TTL as `floor(random() * CARD_TTL_JITTER_SEC)`. */
export const CARD_TTL_JITTER_SEC = 60;

/**
 * How long the single-flight lock lives.
 *
 * Long enough for the slowest honest load, short enough that a leader which died takes the
 * key's crowd with it for no more than this. There is no renewal and no watchdog: the lock
 * is an optimisation, and a lock that needs a heartbeat to stay correct is a lock being
 * asked to do a job it cannot do — see README, "What happens when the stampede lock
 * breaks".
 */
export const LOCK_TTL_MS = 3_000;

/** How often a follower looks to see whether the leader has published yet. */
export const LOCK_POLL_MS = 20;

/**
 * How long "there is no such product" is remembered.
 *
 * Short, because a product that appears should appear soon; non-zero, because without it
 * every request for an id that does not exist is a database query, and an id that does not
 * exist is the cheapest thing in the world for somebody to generate. It also keeps a 404
 * fast under a crowd: without a negative entry the followers of a missing key wait out the
 * whole lock before giving up.
 */
export const CARD_MISS_TTL_SEC = 10;
