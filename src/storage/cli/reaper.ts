import 'reflect-metadata';
import { Worker } from 'bullmq';
import { openRedisStand } from '../../redis/utils/redis-stand.util';
import { REAP_EVERY_MS, REAP_QUEUE } from '../constants/reaper.constant';
import { FilesRepository } from '../repositories/files.repository';
import { UploadQueue } from '../services/upload-queue.service';
import { UploadReaper } from '../services/upload-reaper.service';
import { openStorageStand } from '../utils/storage-stand.util';

/**
 * The process that clears up after uploads nobody finished.
 *
 *   npm run start:reaper
 *
 * The fourth long-running process, beside the outbox relay, the receipt consumer and the
 * card worker — and separate for the reason all of them are: a sweep that wedges on a
 * slow `DeleteObject` must not be able to stop `/health` from answering.
 *
 * What it removes is the residue of the two-step contract: a `pending` row older than a
 * day, the object beside it if any arrived, and the multipart tail if one was opened. The
 * bucket's lifecycle rule is the cheaper half of this and does not replace it — it never
 * touches the row, and on MinIO it is not even installable (see
 * `ObjectStore.installLifecycle`).
 */
const SHUTDOWN_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];

async function main(): Promise<void> {
    const redis = await openRedisStand();
    const storage = openStorageStand();

    await storage.store.ensureBucket();

    const reaper = new UploadReaper(new FilesRepository(redis.dataSource), storage.store);
    const queue = new UploadQueue(redis.queue);

    await queue.scheduleSweeps();

    const worker = new Worker(
        REAP_QUEUE,
        async () => {
            const result = await reaper.sweep();

            console.log(
                `swept: claimed=${result.claimed} aborted=${result.aborted} deleted=${result.deleted}`,
            );
        },
        {
            // Its own connection with `maxRetriesPerRequest: null`: a worker blocks on
            // Redis waiting for work and must be patient while the server restarts.
            connection: redis.blocking(),
            concurrency: 1,
        },
    );

    worker.on('failed', (job, error) => {
        console.error(`sweep ${job?.id} failed (attempt ${job?.attemptsMade}): ${error.message}`);
    });

    console.log(`reaping abandoned uploads every ${REAP_EVERY_MS / 60_000} minutes`);

    for (const signal of SHUTDOWN_SIGNALS) {
        process.once(signal, () => {
            void (async () => {
                await worker.close();
                await queue.onModuleDestroy();
                storage.close();
                await redis.close();
                process.exit(0);
            })();
        });
    }
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
