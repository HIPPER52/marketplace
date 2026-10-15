import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * The outbox: an event written in the same transaction as the thing it is about.
 *
 * A broker cannot join a Postgres transaction, so an order and its announcement are two
 * writes to two resource managers, and between them fits a process death. This table
 * removes the second write: the event becomes a row beside the order, both rows commit
 * together or neither does, and a separate process carries the row to the broker
 * afterwards. Two writes reduced to one.
 *
 * The field names are the ones Debezium's Outbox Event Router reads — `aggregate_type`
 * becomes the topic, `aggregate_id` the partition key, `type` the event name, `payload`
 * the body. Nothing here uses Debezium today; the point is that replacing the polling
 * relay with CDC later is a connector configuration rather than a rewrite of every
 * consumer. (Debezium's canonical names carry no underscores — `aggregatetype`,
 * `aggregateid` — so that swap means setting `route.by.field` explicitly. Named here so
 * the day it happens nobody has to rediscover it.)
 *
 * `payload` is a deliberately designed contract, never an ORM entity spread into JSON.
 * Publishing the entity would make every column of this database a public promise, and
 * the first renamed column would break every consumer. See `toOrderPlacedEvent`.
 */
@Entity('outbox')
// Partial, over the only rows a relay ever reads. The table grows with every order while
// the set of unpublished rows stays small, and indexing the whole thing would mean paying
// disk and write time for history no query touches — the same argument as
// idx_orders_pending_created_at in #12. `created_at, id` because that is the relay's
// ORDER BY: a tie on the timestamp still has to resolve the same way for every worker.
@Index('outbox_unpublished_idx', ['createdAt', 'id'], { where: 'published_at IS NULL' })
export class OutboxRecord {
    @PrimaryGeneratedColumn('uuid')
    id!: string;

    /** 'Order'. The aggregate the event is about — a topic, in Debezium's reading. */
    @Column({ name: 'aggregate_type', type: 'text' })
    aggregateType!: string;

    /**
     * The order id, as text. This is the **partitioning key**: whatever ordering exists
     * downstream exists within one aggregate and nowhere else, because SKIP LOCKED hands
     * rows to whichever relay is free.
     */
    @Column({ name: 'aggregate_id', type: 'text' })
    aggregateId!: string;

    /** 'order.placed'. Also the routing key the relay publishes with. */
    @Column({ name: 'type', type: 'text' })
    type!: string;

    @Column({ name: 'payload', type: 'jsonb' })
    payload!: Record<string, unknown>;

    @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
    createdAt!: Date;

    /**
     * NULL means "not carried out yet" — not "lost". A relay sets it *after* the broker
     * has confirmed the publish, which is the order that trades a possible duplicate for
     * an impossible loss. Marking first would mean a failed publish leaves a row nobody
     * will ever look at again.
     */
    @Column({ name: 'published_at', type: 'timestamptz', nullable: true })
    publishedAt!: Date | null;

    /** How many times a relay has tried. Best effort: a crashed attempt cannot count itself. */
    @Column({ name: 'attempts', type: 'int', default: 0 })
    attempts!: number;
}
