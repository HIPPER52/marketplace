import type { EntityManager } from 'typeorm';

/**
 * The inbox — level two of idempotency.
 *
 * Every method takes the caller's EntityManager, because the whole value of this table is
 * that the mark and the effect share one COMMIT. A repository that opened its own
 * transaction would reintroduce, on the consumer, exactly the dual write the outbox
 * removed on the producer: a process dying between the two writes would leave a message
 * marked as handled whose effect never happened, and no redelivery would repair it.
 */
export class ProcessedMessagesRepository {
    constructor(private readonly manager: EntityManager) {}

    /**
     * Returns true when this call is the one that claimed the message, false when another
     * delivery already did.
     *
     * Deduplication through a conflict, not through SELECT-then-INSERT: two deliveries
     * being handled at the same moment would both read "not seen" and both apply the
     * effect. One statement, settled by the primary key.
     *
     * Wrapped in a CTE so the driver sees a SELECT — TypeORM's `query` returns
     * `[rows, affected]` for some commands and a bare array for others, and `rows[0]`
     * reading as the array is the kind of bug that looks like "the message was new".
     */
    async claim(messageId: string, consumer: string): Promise<boolean> {
        const rows = await this.manager.query<{ claimed: number }[]>(
            `WITH inserted AS (
                 INSERT INTO processed_messages (message_id, consumer)
                 VALUES ($1, $2)
                 ON CONFLICT (message_id, consumer) DO NOTHING
                 RETURNING message_id
             )
             SELECT count(*)::int AS claimed FROM inserted`,
            [messageId, consumer],
        );

        return (rows[0]?.claimed ?? 0) === 1;
    }

    async countFor(consumer: string, messageIds: string[]): Promise<number> {
        if (messageIds.length === 0) {
            return 0;
        }

        const rows = await this.manager.query<{ n: number }[]>(
            `SELECT count(*)::int AS n FROM processed_messages
              WHERE consumer = $1 AND message_id = ANY($2::text[])`,
            [consumer, messageIds],
        );

        return rows[0]?.n ?? 0;
    }
}
