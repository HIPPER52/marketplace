import type { DataSource } from 'typeorm';
import {
    OUTBOX_RETENTION_MS,
    PRUNE_INTERVAL_MS,
    RELAY_BATCH,
    RELAY_IDLE_MS,
} from '../constants/outbox.constant';
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
    /** Cleanup passes that failed. Maintenance, so they do not stop the courier. */
    pruneFailed: number;
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
 * A publish that fails **stops** the pass rather than rolling it back: the rows already
 * marked are committed, the failed row keeps `published_at IS NULL`, and the rest release
 * their locks unpublished. Rolling back would have un-marked rows this pass genuinely
 * delivered and sent every one of them a second time for somebody else's failure.
 *
 * What no transaction can prevent is a relay that is *killed* mid-pass: everything it
 * published and had not yet marked goes again. That is the duplicate this whole design
 * pays for, and the batch size is its blast radius — see RELAY_BATCH.
 */
export class OutboxRelay {
    readonly tally: RelayTally = {
        claimed: 0,
        published: 0,
        marked: 0,
        failed: 0,
        pruned: 0,
        pruneFailed: 0,
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
                    // Stop the pass and **commit what is already marked**, rather than
                    // throwing and rolling the batch back. A rollback would un-mark rows
                    // this pass had genuinely published, and every one of them would be
                    // delivered a second time for a failure that had nothing to do with
                    // them. This row keeps `published_at IS NULL` and is claimed again
                    // next pass, which is exactly the intended behaviour; the rows after
                    // it were never published and simply release their locks.
                    failedRow = row.id;
                    break;
                }

                this.tally.published += 1;
                published += 1;

                await this.options.onPublished?.(row);

                await this.outbox.markPublished(manager, row.id);
                this.tally.marked += 1;
            }
        });

        if (failedRow !== null) {
            // After the commit, not inside it: the attempt is a fact about a row this pass
            // deliberately left unpublished, and counting it in the same transaction would
            // be fine — but doing it here keeps the transaction to the one job it has.
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
    async run(intervalMs = RELAY_IDLE_MS, pruneEveryMs = PRUNE_INTERVAL_MS): Promise<void> {
        this.running = true;

        // Zero rather than `Date.now()`: a relay starting after downtime should tidy up
        // before it settles into its rhythm, not a minute later.
        let prunedAt = 0;

        while (this.running) {
            const moved = await this.drainOnce();

            // On a timer, not on an idle pass. Cleanup used to happen only when a pass
            // found nothing to do, which means a relay under sustained load never ran it —
            // the table was tidied exactly when it was not growing and left alone exactly
            // when it was.
            if (Date.now() - prunedAt >= pruneEveryMs) {
                prunedAt = Date.now();

                try {
                    await this.prune();
                } catch {
                    // Deleting old rows is maintenance. A statement timeout or a deadlock
                    // against it says nothing about this relay's ability to carry events,
                    // so it is counted and the loop goes on; the next timer tries again.
                    this.tally.pruneFailed += 1;
                }
            }

            if (moved === 0) {
                await sleep(intervalMs);
            }
        }
    }

    stop(): void {
        this.running = false;
    }
}
