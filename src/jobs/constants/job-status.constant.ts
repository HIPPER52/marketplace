/**
 * The lifecycle of a queued job. Not part of openapi.yaml — nothing about the queue is
 * visible over HTTP — so unlike OrderStatus there is no contract type to check against.
 */
export const JobStatus = {
    New: 'new',
    Done: 'done',
    Failed: 'failed',
} as const;

export type JobStatus = (typeof JobStatus)[keyof typeof JobStatus];

export const JOB_STATUSES = Object.values(JobStatus);

/** What a job asks the worker to do. One kind today; #19 turns these into routing keys. */
export const JobKind = {
    OrderReceipt: 'order_receipt',
} as const;

export type JobKind = (typeof JobKind)[keyof typeof JobKind];

export const JOB_KINDS = Object.values(JobKind);
