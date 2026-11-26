import type { JobsOptions } from 'bullmq';

/**
 * A queue of its own, not a job name on the card queue.
 *
 * Both are periodic maintenance, which is a tempting reason to share — and the wrong one.
 * They touch different stores, fail for different reasons and would be moved to different
 * machines; a queue named for the cards with an upload sweep inside it is a name that
 * stops being true the first time somebody reads it. Its keys live on the `noeviction`
 * instance, like every other queue here.
 */
export const REAP_QUEUE = 'uploads-maintenance';

/** The scheduler's identity. Stable, because `upsertJobScheduler` keys on it. */
export const REAP_SCHEDULER = 'uploads-reap-abandoned';

export const ReaperJob = {
    /** Kill reservations nobody finished, and whatever they left in the bucket. */
    Abandoned: 'reap-abandoned-uploads',
} as const;

export type ReaperJob = (typeof ReaperJob)[keyof typeof ReaperJob];

/**
 * How old a reservation has to be before it is rubbish.
 *
 * A day, which is generously longer than any upload: the longest grant this service hands
 * out is five minutes, so a `pending` row older than that is one nobody is coming back
 * for. Shorter would race a client that is slow; longer only delays the bill.
 */
export const ABANDONED_AFTER_MS = 24 * 60 * 60 * 1_000;

/** How many reservations one pass claims. Bounded for the reason every batch is. */
export const REAP_BATCH = 100;

/** How often the sweep runs. */
export const REAP_EVERY_MS = 15 * 60 * 1_000;

/**
 * A sweep that fails is a sweep that runs again in fifteen minutes, so the retry budget
 * is small and the record is kept long enough to notice a pattern.
 */
export const REAP_JOB_OPTIONS: JobsOptions = {
    attempts: 3,
    backoff: { type: 'exponential', delay: 1_000, jitter: 0.5 },
    removeOnComplete: { age: 3_600 },
    removeOnFail: { age: 24 * 3_600 },
};
