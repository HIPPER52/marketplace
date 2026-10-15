import type { DataSource } from 'typeorm';
import { OUTBOX_RETENTION_MS, RELAY_BATCH, RELAY_IDLE_MS } from '../constants/outbox.constant';
import { OutboxRepository } from '../repositories/outbox.repository';
import type { PendingOutboxRecord } from '../types/outbox.types';
import { sleep } from '../utils/wait.util';
import type { OrderEventPublisher } from './order-event-publisher.service';

export interface RelayTally {
    /** Rows this relay locked. */
    claimed: number;
    /** Publishes the broker confirmed — including ones never marked, which is the point. */
    published: number;
    /** Rows whose `published_at` was actually written. */
    marked: number;
    /** Publishes that failed. The row stays unpublished and is tried again. */
    failed: number;
    /** Carried-out rows deleted as too old to be of further interest. */
    pruned: number;
}

export interface RelayOptions {
    batch?: number;
    /**
     * Runs inside the claiming transaction, after the broker has confirmed the publish and
     * before `published_at` is written.
     *
     * That is the one gap a relay has, and it cannot be closed: the broker and the database
     * do not share a COMMIT either. `demo:crash-relay` dies exactly here, which is how the
     * duplicate this design pays for is demonstrated rather than asserted. Nothing in the
     * application passes it.
     */
    onPublished?: (record: PendingOutboxRecord) => void | Promise<void>;
}

/**
 * The courier: it takes rows out of the outbox and gives them to the broker.
 *
 * ## The order of the two steps, and why it cannot be swapped
 *
 * Publish, **then** mark. Both steps can fail and they are not atomic together, so one of
 * the two orders has to be chosen and each has a different failure:
 *
 *   - publish → mark: a relay that dies in between republishes the row next pass. The
 *     event is delivered **twice**.
 *   - mark → publish: a relay that dies in between leaves a row that says "carried out"
 *     and an event nobody ever received. The event is **lost**.
 *
 * A duplicate is repaired by the consumer's idempotent effect. A loss is repaired by
 * nothing — there is no record anywhere that something is missing. So the choice is not
 * between a good order and a bad one; it is between a duplicate and a loss, and this is
 * the one that can be paid for.
 *
 * It is worse than it looks, too: a publish that *reports* failure does not mean the
 * message was not delivered. What went missing may have been the broker's answer. "Catch
 * the error, roll back, all clean" is therefore not available either, and deduplication on
 * the consumer is mandatory however careful this class is.
 *
 * ## Why the mark is inside the claiming transaction
 *
 * `claimBatch` locks its rows with `FOR UPDATE SKIP LOCKED`, and that lock lives until the
 * transaction ends. Marking inside it means a relay that dies releases the lock with its
 * connection and the row is immediately claimable again. Marking in a second transaction
 * would hand the row to another relay while this one was still publishing it.
 *
 * A failure anywhere in the batch rolls the whole batch back, so rows published earlier in
 * the same pass are published again later. That is deliberate: a smaller blast radius
 * would need a transaction per row, which is a round trip per row for a problem the
 * consumer already solves.
 */
export class OutboxRelay {
    readonly tally: RelayTally = {
        claimed: 0,
        published: 0,
        marked: 0,
        failed: 0,
        pruned: 0,
    };

    private readonly outbox = new OutboxRepository();
    private readonly batch: number;
    private running = false;

    constructor(
        private readonly dataSource: DataSource,
        private readonly publisher: OrderEventPublisher,
        private readonly options: RelayOptions = {},
    ) {
        this.batch = options.batch ?? RELAY_BATCH;
    }

    /** One pass. Returns how many rows reached the broker in it. */
    async drainOnce(): Promise<number> {
        let published = 0;
        let failedRow: string | null = null;

        try {
            await this.dataSource.transaction(async (manager) => {
                const rows = await this.outbox.claimBatch(manager, this.batch);
                this.tally.claimed += rows.length;

                for (const row of rows) {
                    try {
                        await this.publisher.publish({
                            id: row.id,
                            type: row.type,
                            payload: row.payload,
                        });
                    } catch (error: unknown) {
                        failedRow = row.id;
                        throw error;
                    }

                    this.tally.published += 1;
                    published += 1;

                    await this.options.onPublished?.(row);

                    await this.outbox.markPublished(manager, row.id);
                    this.tally.marked += 1;
                }
            });
        } catch (error: unknown) {
            if (failedRow === null) {
                throw error;
            }

            // Its own statement, outside the transaction that just rolled back — that
            // transaction would have taken the count with it.
            this.tally.failed += 1;
            await this.outbox.recordAttempt(this.dataSource.manager, failedRow);
        }

        return published;
    }

    /**
     * Deletes rows carried out long enough ago to be of no further interest. Without it the
     * table grows forever and drags the partial index this relay's own query depends on.
     */
    async prune(retentionMs = OUTBOX_RETENTION_MS): Promise<number> {
        const removed = await this.outbox.prune(this.dataSource.manager, retentionMs);
        this.tally.pruned += removed;

        return removed;
    }

    /**
     * Polls until stopped.
     *
     * Polling, not LISTEN/NOTIFY: latency here is bounded by the interval, and one service
     * with one relay does not need better. NOTIFY would cut it to nothing — and it fires
     * only after COMMIT, which is exactly right for an outbox — but it is a second
     * mechanism to keep correct, and the poll has to stay anyway as the thing that catches
     * a row whose notification was missed.
     */
    async run(intervalMs = RELAY_IDLE_MS): Promise<void> {
        this.running = true;

        while (this.running) {
            const moved = await this.drainOnce();

            if (moved === 0) {
                await this.prune();
                await sleep(intervalMs);
            }
        }
    }

    stop(): void {
        this.running = false;
    }
}
