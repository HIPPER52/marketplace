/**
 * Which aggregate an outbox row is about. Debezium's Outbox Event Router turns this into
 * the destination topic, which is why it is a short domain noun and not a table name.
 */
export const AggregateType = {
    Order: 'Order',
} as const;

export type AggregateType = (typeof AggregateType)[keyof typeof AggregateType];

/** How many rows a relay claims in one pass. */
export const RELAY_BATCH = 100;

/** How long a relay waits before looking again when it found nothing. */
export const RELAY_IDLE_MS = 250;

/**
 * How long a published row is kept before the relay deletes it.
 *
 * The table grows with every order and drags the partial index the relay itself depends
 * on, so something has to remove published rows. Doing it in the relay's own pass is the
 * cheapest form that is actually true rather than intended — the alternatives are a
 * separate cron and partitioning, and both are more machinery than one DELETE.
 *
 * An hour rather than "immediately after publish": a row that has just been carried out is
 * the only evidence of what was sent, and a few minutes of it is worth having when
 * somebody asks why a consumer saw what it saw. Nothing reads rows older than that.
 */
export const OUTBOX_RETENTION_MS = 60 * 60 * 1000;
