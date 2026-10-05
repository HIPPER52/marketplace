import type { DataSource } from 'typeorm';
import { sleep } from '../../database/utils/with-retry.util';
import { JobStatus } from '../constants/job-status.constant';
import { Job } from '../entities/job.entity';

export type ClaimOutcome = 'done' | 'none-free';

/**
 * One worker pulling from the `jobs` table.
 *
 * The claim is `FOR UPDATE SKIP LOCKED`, written here through the QueryBuilder as
 * `setLock('pessimistic_write').setOnLocked('skip_locked')`. Two properties come from that
 * one clause:
 *
 *   - no two workers get the same row, because the row lock is exclusive;
 *   - no worker waits behind another, because SKIP LOCKED steps over what is already held
 *     instead of queueing for it. Plain FOR UPDATE would make four workers take turns on
 *     the same head of the queue and run no faster than one.
 *
 * The lock lives for the whole transaction, which is why the work happens inside it: a
 * worker that dies before COMMIT releases the lock and the job returns to the queue, having
 * never been marked done. Status and result commit together or not at all.
 */
export class JobWorker {
    constructor(
        private readonly dataSource: DataSource,
        readonly name: string,
    ) {}

    /**
     * An empty result means "nothing free right now", not "the queue is empty" — the rest
     * may simply be locked by somebody else. Deciding to stop is the caller's job.
     */
    async claimOne(workMs: number): Promise<ClaimOutcome> {
        return this.dataSource.transaction(async (manager) => {
            const job = await manager
                .createQueryBuilder(Job, 'job')
                .setLock('pessimistic_write')
                .setOnLocked('skip_locked')
                .where('job.status = :status', { status: JobStatus.New })
                .orderBy('job.id', 'ASC')
                .limit(1)
                .getOne();

            if (job === null) {
                return 'none-free';
            }

            // The actual work — sending the receipt, in this domain. Held inside the
            // transaction on purpose: see the note above.
            await sleep(workMs);

            await manager.query(
                `UPDATE jobs
                    SET status = $1, worker = $2, processed = processed + 1, processed_at = now()
                  WHERE id = $3`,
                [JobStatus.Done, this.name, job.id],
            );

            return 'done';
        });
    }

    /** Drains the queue, re-checking before giving up. */
    async run(workMs: number, idleRecheckMs: number): Promise<number> {
        let handled = 0;

        for (;;) {
            const outcome = await this.claimOne(workMs);

            if (outcome === 'done') {
                handled += 1;
                continue;
            }

            const remaining = await this.dataSource
                .getRepository(Job)
                .countBy({ status: JobStatus.New });

            if (remaining === 0) {
                return handled;
            }

            await sleep(idleRecheckMs);
        }
    }
}
