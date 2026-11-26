import type { EntityManager } from 'typeorm';
import { OUTBOX_RETENTION_MS, RELAY_BATCH } from '../constants/outbox.constant';
import type { NewOutboxRecord, PendingOutboxRecord } from '../types/outbox.types';

/**
 * The one thing a business transaction needs from the outbox.
 *
 * An interface rather than a concrete class because it is a genuine seam: production
 * passes the repository below, and `demo:crash-write` passes one that writes the row and
 * then fails — which is how the failing side of a transaction gets demonstrated without a
 * test-only branch inside CheckoutService.
 */
export interface OutboxWriter {
    append(manager: EntityManager, record: NewOutboxRecord): Promise<void>;
}

interface Row {
    id: string;
    aggregate_type: string;
    aggregate_id: string;
    type: string;
    payload: Record<string, unknown>;
    attempts: number;
}

export class OutboxRepository implements OutboxWriter {
    /**
     * Takes the caller's EntityManager, never its own. That is the entire point: this
     * INSERT has to be inside the transaction that writes the order, so that the two rows
     * commit together or neither does.
     */
    async append(manager: EntityManager, record: NewOutboxRecord): Promise<void> {
        await manager.query(
            `INSERT INTO outbox (id, aggregate_type, aggregate_id, type, payload)
             VALUES ($1, $2, $3, $4, $5::jsonb)`,
            [
                record.id,
                record.aggregateType,
                record.aggregateId,
                record.type,
                JSON.stringify(record.payload),
            ],
        );
    }

    /**
     * Claims a batch for this relay and nobody else.
     *
     * `FOR UPDATE SKIP LOCKED`, not a bare `FOR UPDATE`: the lecture measured three relays
     * over one table, and plain FOR UPDATE gives zero duplicates at the price of zero
     * parallelism — the second and third relay queue behind the first and finish in one
     * relay's time. SKIP LOCKED gives zero duplicates *and* the parallelism.
     *
     * `WHERE published_at IS NULL`, not a cursor over ids. A bigserial takes its number at
     * `nextval` and the row becomes visible at COMMIT, so two concurrent inserts can become
     * visible out of order and "everything above the last id I saw" silently skips one.
     * The nullable timestamp cannot be skipped: a row is either carried out or it is not.
     *
     * `ORDER BY created_at, id` orders the *selection*, not the delivery. SKIP LOCKED hands
     * rows to whichever relay is free, so the only ordering that survives downstream is
     * within one `aggregate_id`.
     *
     * The lock lives for the whole transaction, which is why the mark in `markPublished`
     * must happen inside it: a relay that dies in between releases the lock with its
     * connection and the row is claimed again — by design.
     */
    async claimBatch(manager: EntityManager, limit = RELAY_BATCH): Promise<PendingOutboxRecord[]> {
        const rows = await manager.query<Row[]>(
            `SELECT id, aggregate_type, aggregate_id, type, payload, attempts
               FROM outbox
              WHERE published_at IS NULL
              ORDER BY created_at, id
                FOR UPDATE SKIP LOCKED
              LIMIT $1`,
            [limit],
        );

        return rows.map((row) => ({
            id: row.id,
            aggregateType: row.aggregate_type,
            aggregateId: row.aggregate_id,
            type: row.type,
            payload: row.payload,
            attempts: Number(row.attempts),
        }));
    }

    /** Only ever called after the broker has confirmed. See OutboxRelay for why. */
    async markPublished(manager: EntityManager, id: string): Promise<void> {
        await manager.query(
            'UPDATE outbox SET published_at = now(), attempts = attempts + 1 WHERE id = $1',
            [id],
        );
    }

    /**
     * Counts a try that did not end in a mark. Its own statement, outside the claiming
     * transaction, because that transaction is about to be rolled back and would take the
     * count with it.
     */
    async recordAttempt(manager: EntityManager, id: string): Promise<void> {
        await manager.query('UPDATE outbox SET attempts = attempts + 1 WHERE id = $1', [id]);
    }

    /**
     * Removes rows carried out long enough ago to be of no further interest.
     *
     * Without this the table grows forever and drags `outbox_unpublished_idx` — the index
     * the relay's own query depends on — behind it. Deleting in the relay's pass rather
     * than from a cron keeps the claim about cleanup true rather than aspirational.
     */
    async prune(manager: EntityManager, retentionMs = OUTBOX_RETENTION_MS): Promise<number> {
        const [, affected] = (await manager.query(
            `DELETE FROM outbox
              WHERE published_at IS NOT NULL
                AND published_at < now() - make_interval(secs => $1)`,
            [retentionMs / 1000],
        )) as [unknown, number];

        return affected ?? 0;
    }
}
