import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { Order } from './order.entity';

/**
 * `Idempotency-Key` with server mechanics behind it — level three.
 *
 * #09 declared the header and #11 honoured it from a `Map` in the process. That worked
 * exactly as long as there was one process and it never restarted, which is to say it was
 * the anti-pattern this lecture names: a deduplication set in memory is not deduplication,
 * because the guarantee lasts precisely as long as one instance and does not exist between
 * two replicas.
 *
 * The row is created **before** the order is placed, not after. That ordering is the whole
 * mechanism: `INSERT … ON CONFLICT DO NOTHING` either reserves the key or tells you
 * somebody else already holds it, in one statement the database settles. Writing the key
 * after a successful checkout would leave the window two simultaneous requests need —
 * both read "not seen", both place an order, and the key that was supposed to prevent that
 * records the second one.
 *
 * `order_id` is NULL while the request is in flight and set in the same transaction that
 * writes the order. That is the same rule the inbox follows: the mark and the effect share
 * a COMMIT, or the mark is a lie waiting to be told.
 *
 * The key identifies an **intent**, not a body. Two legitimately identical orders are two
 * intents and must get two keys; `request_hash` is here only to catch a client reusing one
 * key for a different request, which is a bug worth a 422 rather than a silent replay.
 */
@Entity('idempotency_keys')
// The referencing side of the foreign key. Postgres indexes the referenced side for you
// and this one not at all, so without it a DELETE on `orders` scans this table — the same
// rule db/indexes.sql follows for idx_order_items_product_id.
@Index('idx_idempotency_keys_order_id', ['order'])
export class IdempotencyKey {
    @PrimaryColumn({ name: 'key', type: 'text' })
    key!: string;

    /** sha256 of the canonicalised body. Not identity — a check against misuse. */
    @Column({ name: 'request_hash', type: 'text' })
    requestHash!: string;

    /** NULL while the first request is still running. */
    @Column({ name: 'order_id', type: 'uuid', nullable: true })
    orderId!: string | null;

    /**
     * CASCADE: a key whose order no longer exists has nothing to replay, and leaving it
     * would answer a retry with a reference to a row that is gone.
     */
    @ManyToOne(() => Order, { nullable: true, onDelete: 'CASCADE' })
    @JoinColumn({ name: 'order_id' })
    order!: Order | null;

    /** When the key was reserved. A reservation this old is assumed abandoned. */
    @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
    createdAt!: Date;
}
