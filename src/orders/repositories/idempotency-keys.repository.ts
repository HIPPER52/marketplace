import type { DataSource, EntityManager } from 'typeorm';
import { KeyClaimOutcome } from '../constants/outcome.constant';

/** How long a reservation nobody completed is honoured before another request may take it. */
export const RESERVATION_STALE_MS = 60_000;

export type KeyClaim =
    | { outcome: typeof KeyClaimOutcome.Claimed }
    | { outcome: typeof KeyClaimOutcome.Replay; orderId: string }
    | { outcome: typeof KeyClaimOutcome.Conflict }
    | { outcome: typeof KeyClaimOutcome.InFlight };

/**
 * What a business transaction needs in order to finish a reservation.
 *
 * An interface because the completion happens *inside* CheckoutService's transaction, and
 * the service should depend on the one operation it performs rather than on a repository
 * with four others.
 */
export interface IdempotencyCompleter {
    complete(manager: EntityManager, key: string, orderId: string): Promise<void>;
}

export class IdempotencyKeysRepository implements IdempotencyCompleter {
    constructor(private readonly dataSource: DataSource) {}

    /**
     * Reserves the key, or says who already holds it.
     *
     * The reservation is taken **before** the order is placed. Recording the key after a
     * successful checkout — which is what the in-memory version did — leaves exactly the
     * window two simultaneous requests need: both read "not seen", both place an order,
     * and the key meant to prevent the second one ends up describing it. One statement
     * settled by the primary key has no such window.
     *
     * `DO UPDATE … WHERE` is how a reservation nobody finished becomes takeable: a request
     * that died before completing would otherwise hold its key forever. The hash has to
     * match even then — an abandoned key reused for a different body is a client bug, and
     * it gets a 422 rather than a quiet takeover.
     */
    async claim(key: string, requestHash: string): Promise<KeyClaim> {
        const claimed = await this.dataSource.query<{ key: string }[]>(
            `INSERT INTO idempotency_keys (key, request_hash)
             VALUES ($1, $2)
             ON CONFLICT (key) DO UPDATE
                SET created_at = now()
              WHERE idempotency_keys.order_id IS NULL
                AND idempotency_keys.created_at < now() - make_interval(secs => $3)
                AND idempotency_keys.request_hash = EXCLUDED.request_hash
             RETURNING key`,
            [key, requestHash, RESERVATION_STALE_MS / 1000],
        );

        if (claimed.length === 1) {
            return { outcome: KeyClaimOutcome.Claimed };
        }

        const rows = await this.dataSource.query<
            { request_hash: string; order_id: string | null }[]
        >('SELECT request_hash, order_id FROM idempotency_keys WHERE key = $1', [key]);
        const held = rows[0];

        if (held === undefined) {
            // Deleted between the two statements — a first attempt that refused and
            // released its key. Asking again is the right answer, not an error.
            return this.claim(key, requestHash);
        }

        if (held.request_hash !== requestHash) {
            return { outcome: KeyClaimOutcome.Conflict };
        }

        return held.order_id === null
            ? { outcome: KeyClaimOutcome.InFlight }
            : { outcome: KeyClaimOutcome.Replay, orderId: held.order_id };
    }

    /**
     * Takes the caller's EntityManager on purpose: this runs inside the transaction that
     * writes the order, so the key and the order it names commit together. The same rule
     * the inbox follows — a mark that can outlive its effect is a mark that lies.
     */
    async complete(manager: EntityManager, key: string, orderId: string): Promise<void> {
        await manager.query('UPDATE idempotency_keys SET order_id = $2 WHERE key = $1', [
            key,
            orderId,
        ]);
    }

    /**
     * Frees a reservation whose checkout refused — out of stock, no such product. Nothing
     * was written, so holding the key for a minute would turn a retryable answer into a
     * dead key.
     */
    async release(key: string): Promise<void> {
        await this.dataSource.query(
            'DELETE FROM idempotency_keys WHERE key = $1 AND order_id IS NULL',
            [key],
        );
    }
}
