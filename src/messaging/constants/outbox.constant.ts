/**
 * Which aggregate an outbox row is about. Debezium's Outbox Event Router turns this into
 * the destination topic, which is why it is a short domain noun and not a table name.
 */
export const AggregateType = {
    Order: 'Order',
} as const;

export type AggregateType = (typeof AggregateType)[keyof typeof AggregateType];

/**
 * How many rows a relay claims in one pass.
 *
 * Small on purpose. A publish that *fails* no longer costs anything — the pass commits the
 * rows it already marked and leaves the rest — but a relay that is **killed** mid-pass
 * takes its whole uncommitted transaction with it, so every row it published and had not
 * yet marked is published again. The batch size is therefore the blast radius of a crash:
 * at ten, at most nine rows are re-delivered, and the consumer's natural key absorbs them.
 *
 * A transaction per row would make it zero and cost a round trip per row. Ten is an order
 * of magnitude cheaper than that and an order of magnitude smaller than the hundred this
 * started as.
 */
export const RELAY_BATCH = 10;

/** How long a relay waits before looking again when it found nothing. */
export const RELAY_IDLE_MS = 250;

/**
 * How often the relay deletes carried-out rows, measured from the last time it did.
 *
 * On a timer rather than "whenever a pass finds nothing to do". A busy relay never has an
 * idle pass, so tying cleanup to idleness means the table is tidied exactly when it is not
 * growing and left alone exactly when it is.
 */
export const PRUNE_INTERVAL_MS = 60_000;

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
