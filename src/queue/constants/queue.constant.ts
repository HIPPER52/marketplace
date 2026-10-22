import type { JobsOptions } from 'bullmq';

/** One queue. Its keys live on the `noeviction` instance — see redis-env.schema.ts. */
export const CARD_QUEUE = 'product-cards';

/** What the queue carries. */
export const CardJob = {
    /** Recompute one card and publish it. Enqueued when an order moved the stock. */
    Refresh: 'refresh-card',
    /** Keep the cards of recently-sold products warm, so a TTL never catches a customer. */
    Warm: 'warm-hot-cards',
} as const;

export type CardJob = (typeof CardJob)[keyof typeof CardJob];

/**
 * How a job behaves when it fails, and how long its record sticks around.
 *
 * `attempts: 3` with exponential backoff, because the things this job touches — Postgres,
 * Redis — fail in bursts rather than permanently, and a retry a second later usually
 * lands. `jitter` because without it every job that failed during the same blip retries at
 * the same instant and reproduces the blip; it is the same argument as the cache TTL's
 * jitter, applied to time instead of to keys.
 *
 * **`removeOnComplete` is an age, never `true`.** BullMQ deduplicates by `jobId` against
 * jobs that still exist, so removing a job the moment it completes removes the record that
 * made the next identical `add` a duplicate — the documentation says so outright. An hour
 * is comfortably longer than any window in which a repeat would be meaningful.
 */
export const CARD_JOB_OPTIONS: JobsOptions = {
    attempts: 3,
    backoff: { type: 'exponential', delay: 200, jitter: 0.5 },
    removeOnComplete: { age: 3_600 },
    removeOnFail: { age: 24 * 3_600 },
};

/** The scheduler's identity. Stable, because `upsertJobScheduler` keys on it. */
export const WARM_SCHEDULER = 'product-cards-warm';

/** How often the warmer runs. */
export const WARM_EVERY_MS = 60_000;

/** How many recently-sold products one warming pass refreshes. */
export const WARM_BATCH = 20;
