import type { EntityManager } from 'typeorm';
import type { Currency } from '../../common/constants/currency.constant';

export interface NewReceipt {
    orderId: string;
    eventId: string;
    totalCents: number;
    currency: Currency;
}

/**
 * Reads and writes of `order_receipts`.
 *
 * Plain SQL rather than `manager.save()`: `save` reads the row, decides between INSERT and
 * UPDATE, and then writes — which is a read-modify-write around a race, and would turn two
 * simultaneous deliveries of one event into a duplicate-key error instead of a quiet
 * no-op. `ON CONFLICT DO NOTHING` is one statement and the database settles it.
 */
export class OrderReceiptsRepository {
    constructor(private readonly manager: EntityManager) {}

    /**
     * Returns true when this call is the one that issued the receipt, false when it was
     * already there — which is the whole signal a consumer needs to tell an effect from a
     * duplicate.
     *
     * The INSERT is wrapped in a CTE so that the statement the driver sees is a SELECT.
     * TypeORM hands back `[rows, affected]` for some commands and a bare rows array for
     * others, and `rows[0]` reading as the array rather than the row is the kind of bug
     * that looks like "the receipt was never issued". A SELECT has one shape.
     */
    async issue(receipt: NewReceipt): Promise<boolean> {
        const rows = await this.manager.query<{ applied: number }[]>(
            `WITH inserted AS (
                 INSERT INTO order_receipts (order_id, event_id, total_cents, currency)
                 VALUES ($1, $2, $3, $4)
                 ON CONFLICT (order_id) DO NOTHING
                 RETURNING order_id
             )
             SELECT count(*)::int AS applied FROM inserted`,
            [receipt.orderId, receipt.eventId, receipt.totalCents, receipt.currency],
        );

        return (rows[0]?.applied ?? 0) === 1;
    }

    async countFor(orderIds: string[]): Promise<number> {
        if (orderIds.length === 0) {
            return 0;
        }

        const rows = await this.manager.query<{ n: number }[]>(
            'SELECT count(*)::int AS n FROM order_receipts WHERE order_id = ANY($1::uuid[])',
            [orderIds],
        );

        return rows[0]?.n ?? 0;
    }

    /** What a demo calls to own its starting conditions. */
    async forget(orderIds: string[]): Promise<void> {
        if (orderIds.length === 0) {
            return;
        }

        await this.manager.query('DELETE FROM order_receipts WHERE order_id = ANY($1::uuid[])', [
            orderIds,
        ]);
    }
}
