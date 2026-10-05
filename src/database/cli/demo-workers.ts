import 'reflect-metadata';
import { JobKind, JobStatus } from '../../jobs/constants/job-status.constant';
import { JobWorker } from '../../jobs/services/job-worker.service';
import { AppDataSource } from '../data-source';

/**
 * Four workers against one queue.
 *
 *   npm run demo:workers
 *
 * Twelve jobs, a tenth of a second of work each. One worker would take 1200 ms. Four
 * workers sharing the queue through FOR UPDATE SKIP LOCKED should take about a quarter of
 * that — and, more importantly, each job must be carried out exactly once.
 *
 * Both are checked, and the process fails if either breaks: a job done twice is a receipt
 * sent twice, and four workers that take as long as one are four workers queueing behind
 * the same locked row.
 */

const JOB_COUNT = 12;
const WORKER_COUNT = 4;
const WORK_MS = 100;
const IDLE_RECHECK_MS = 5;

async function main(): Promise<void> {
    const ds = await AppDataSource.initialize();

    try {
        // ---- fixture: a queue the run owns -------------------------------------------
        // The whole table, not just the rows this script inserts. A worker drains the queue
        // it is pointed at; leaving the receipts that demo:race queued would mean the pool
        // processes 22 jobs while the report counts 12, and every number below — the
        // distribution, the speed-up — would describe a run that did not happen.
        await ds.query('DELETE FROM jobs');
        await ds.query(
            `INSERT INTO jobs (kind, status, payload)
             SELECT $1, $2, jsonb_build_object('n', g)
               FROM generate_series(1, $3) AS g`,
            [JobKind.OrderReceipt, JobStatus.New, JOB_COUNT],
        );

        const sequentialMs = JOB_COUNT * WORK_MS;
        console.log(`queued:     ${JOB_COUNT} jobs of ${WORK_MS} ms`);
        console.log(`workers:    ${WORKER_COUNT}`);
        console.log(`sequential: ${sequentialMs} ms — what one worker would take\n`);

        // ---- the drain ---------------------------------------------------------------
        const workers = Array.from(
            { length: WORKER_COUNT },
            (_, index) => new JobWorker(ds, `w${index + 1}`),
        );

        const startedAt = Date.now();
        const handled = await Promise.all(
            workers.map((worker) => worker.run(WORK_MS, IDLE_RECHECK_MS)),
        );
        const elapsedMs = Date.now() - startedAt;

        // ---- what the table says ------------------------------------------------------
        const distribution = await ds.query<{ worker: string; n: string }[]>(
            `SELECT worker, count(*) AS n FROM jobs
              WHERE worker IS NOT NULL
              GROUP BY worker ORDER BY worker`,
        );
        const twice = await scalar(ds, 'SELECT count(*) AS n FROM jobs WHERE processed > 1');
        const unprocessed = await scalar(ds, 'SELECT count(*) AS n FROM jobs WHERE processed = 0');

        console.log(
            `distribution:  ${distribution.map((row) => `${row.worker}=${row.n}`).join(' ')}`,
        );
        console.log(`claimed:       ${workers.map((w, i) => `${w.name}=${handled[i]}`).join(' ')}`);
        console.log(`processed twice: ${twice}`);
        console.log(`never processed: ${unprocessed}`);
        console.log(`elapsed:       ${elapsedMs} ms against ${sequentialMs} ms sequential`);

        // ---- the invariants -------------------------------------------------------------
        const failures: string[] = [];

        if (twice !== 0) {
            failures.push(`${twice} jobs were carried out more than once`);
        }

        if (unprocessed !== 0) {
            failures.push(`${unprocessed} jobs were never carried out`);
        }

        if (distribution.length < 2) {
            failures.push(`only ${distribution.length} worker(s) got anything — no sharing`);
        }

        if (elapsedMs >= sequentialMs) {
            failures.push(
                `${elapsedMs} ms is no better than one worker (${sequentialMs} ms) — ` +
                    'the pool is queueing on the same row',
            );
        }

        if (failures.length > 0) {
            console.error('\nFAIL:\n');
            for (const failure of failures) {
                console.error(`  ${failure}`);
            }
            process.exitCode = 1;
            return;
        }

        console.log(
            `\nOK — every job exactly once, shared across ${distribution.length} workers, in` +
                ` ${Math.round((sequentialMs / elapsedMs) * 10) / 10}× less time than one.`,
        );
    } finally {
        await ds.destroy();
    }
}

async function scalar(ds: typeof AppDataSource, sql: string): Promise<number> {
    const rows = await ds.query<{ n: string }[]>(sql);

    return Number(rows[0]?.n ?? 0);
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
