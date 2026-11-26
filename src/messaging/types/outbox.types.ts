/** A row on its way into the outbox, written inside the business transaction. */
export interface NewOutboxRecord {
    /**
     * Supplied by the caller rather than defaulted by the database, because the same value
     * is the event's id inside the payload. One identifier, two places that need it before
     * the INSERT returns.
     */
    id: string;
    aggregateType: string;
    aggregateId: string;
    type: string;
    payload: Record<string, unknown>;
}

/** A row a relay has claimed and is about to publish. */
export interface PendingOutboxRecord {
    id: string;
    aggregateType: string;
    aggregateId: string;
    type: string;
    payload: Record<string, unknown>;
    attempts: number;
}
