import 'reflect-metadata';
import { type Job, Queue, Worker } from 'bullmq';
import { emit, finish, sleep, waitUntil } from '../../common/utils/demo-report.util';
import { evictionPolicy, openRedisStand } from '../../redis/utils/redis-stand.util';
import { CARD_JOB_OPTIONS } from '../constants/queue.constant';

/**
 * What a queue does that a function call cannot: retry, deduplicate, and come back later.
 *
 *   npm run demo:queue
 *
 *   `added` / `queued`   two `add` calls with the same `jobId` leave **one** job waiting.
 *                        That is deduplication by natural key, applied to work.
 *   `attempts`           a handler that fails twice is run a third time, on the backoff
 *                        the production options declare — exponential, with jitter.
 *   `scheduled-runs`     a scheduler installed with `upsertJobScheduler` fires repeatedly
 *                        without anybody adding anything.
 *
 * On its own queue name, deliberately. A demo brings its own state to clean, and the only
 * way to be sure a queue is empty is to obliterate it — which is not something that may be
 * done to the queue a deployment is using. The options under test are the production ones.
 */

// BullMQ 6 refuses a queue name containing ':' — it builds its own key names with
// that separator, so a colon here would collide with the structure it writes.
const DEMO_QUEUE = 'product-cards-demo';
const FLAKY = 'flaky';
const DEDUPED = 'deduped';
const SCHEDULED = 'scheduled';
const SCHEDULER_ID = 'product-cards-demo-tick';
const EVERY_MS = 400;
const FAIL_TIMES = 2;

async function main(): Promise<void> {
    const stand = await openRedisStand();
    const queue = new Queue(DEMO_QUEUE, { connection: stand.queue });
    let worker: Worker | null = null;

    try {
        const { policy } = await evictionPolicy(stand.queue);
        console.log(`queue instance: maxmemory-policy=${policy}`);

        // The run owns the queue it measures.
        await queue.obliterate({ force: true });

        // ---- two adds, one job ----------------------------------------------------------
        const jobId = `${DEDUPED}-42`;
        await queue.add(DEDUPED, { productId: '42' }, { ...CARD_JOB_OPTIONS, jobId });
        await queue.add(DEDUPED, { productId: '42' }, { ...CARD_JOB_OPTIONS, jobId });

        const counts = await queue.getJobCounts('wait', 'delayed', 'active');
        const queued = (counts.wait ?? 0) + (counts.delayed ?? 0) + (counts.active ?? 0);
        console.log(`two adds with jobId "${jobId}" left ${queued} job(s) in the queue`);

        // ---- a handler that fails twice --------------------------------------------------
        const tally = { attempts: 0, completed: 0, scheduled: 0 };

        worker = new Worker(
            DEMO_QUEUE,
            async (job: Job) => {
                if (job.name === SCHEDULED) {
                    tally.scheduled += 1;
                    return;
                }

                if (job.name === FLAKY) {
                    tally.attempts += 1;

                    if (tally.attempts <= FAIL_TIMES) {
                        throw new Error(`attempt ${tally.attempts} refused on purpose`);
                    }
                }
            },
            // Its own connection with `maxRetriesPerRequest: null`: a worker blocks waiting
            // for work, and the default retry budget would make it throw at exactly the
            // moment it should be patient.
            { connection: stand.blocking(), concurrency: 1 },
        );

        worker.on('completed', (job) => {
            if (job.name === FLAKY) {
                tally.completed += 1;
            }
        });

        await queue.add(FLAKY, { why: 'to be retried' }, CARD_JOB_OPTIONS);

        // ---- and a scheduler ---------------------------------------------------------------
        await queue.upsertJobScheduler(
            SCHEDULER_ID,
            { every: EVERY_MS },
            { name: SCHEDULED, opts: CARD_JOB_OPTIONS },
        );

        await waitUntil(
            'the flaky job to succeed and the scheduler to fire twice',
            () => tally.completed >= 1 && tally.scheduled >= 2,
            { timeoutMs: 30_000, intervalMs: 50 },
        ).catch(() => {
            // Reported below, with the numbers.
        });

        const schedulers = (await queue.getJobSchedulers()).length;

        console.log(
            `\nthe flaky job ran ${tally.attempts} time(s) and completed ${tally.completed};` +
                ` the scheduler fired ${tally.scheduled} time(s)`,
        );

        emit({
            'queue-noeviction': policy === 'noeviction' ? 1 : 0,
            attempts: tally.attempts,
            completed: tally.completed,
            added: 2,
            queued,
            schedulers,
            'scheduled-runs': tally.scheduled,
        });

        const failures: string[] = [];

        if (policy !== 'noeviction') {
            failures.push(
                `the queue instance answers maxmemory-policy=${policy}; BullMQ's own ` +
                    'documentation says it cannot work properly if Redis evicts keys',
            );
        }

        if (queued !== 1) {
            failures.push(
                `two adds with one jobId left ${queued} job(s); removeOnComplete: true is ` +
                    'the usual reason deduplication stops working',
            );
        }

        if (tally.attempts < 3) {
            failures.push(`the failing job ran ${tally.attempts} time(s); it should be retried`);
        }

        if (tally.completed !== 1) {
            failures.push(`the failing job completed ${tally.completed} time(s), expected 1`);
        }

        if (schedulers < 1) {
            failures.push('no scheduler is installed');
        }

        if (tally.scheduled < 2) {
            failures.push(
                `the scheduler fired ${tally.scheduled} time(s) in the window; it is supposed ` +
                    'to keep firing without anybody adding anything',
            );
        }

        finish(
            failures,
            `two adds became one job, a handler that failed twice succeeded on attempt ` +
                `${tally.attempts},\nand a scheduler fired ${tally.scheduled} times on its own. ` +
                'All of it on an instance that is\nforbidden to evict, because a queue whose ' +
                'keys may vanish is not a queue.',
        );
    } finally {
        if (worker !== null) {
            await worker.close();
        }

        await queue.obliterate({ force: true }).catch(() => {});
        await queue.close();
        await sleep(50);
        await stand.close();
    }
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
