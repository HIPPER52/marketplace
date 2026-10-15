import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * The inbox: which messages this consumer has already acted on.
 *
 * Level two of idempotency. Level one is the effect expressed through a natural key —
 * `order_receipts.order_id` — and it is the cheaper and better one wherever it fits. This
 * table is what level one cannot do: it works for an effect that has no natural key of its
 * own, and it records the decision rather than inferring it.
 *
 * **The mark and the effect are written in one transaction.** Two transactions would be
 * the same dual write the outbox exists to remove, moved onto the consumer: a process that
 * died between them would leave a message marked as handled whose effect never happened,
 * and no redelivery would ever repair it. A mark in Redis beside an effect in Postgres is
 * that same bug wearing a different hat.
 *
 * The key is (message_id, consumer), not message_id alone. One event legitimately reaches
 * several consumers, and each has to decide for itself whether it has acted.
 */
@Entity('processed_messages')
export class ProcessedMessage {
    /** The event id from the envelope — stable across republishes by construction. */
    @PrimaryColumn({ name: 'message_id', type: 'text' })
    messageId!: string;

    /** Which reader. A name, not a hostname: replicas of one consumer share a mark. */
    @PrimaryColumn({ name: 'consumer', type: 'text' })
    consumer!: string;

    @Column({ name: 'processed_at', type: 'timestamptz', default: () => 'now()' })
    processedAt!: Date;
}
