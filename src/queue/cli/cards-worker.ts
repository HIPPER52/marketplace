import 'reflect-metadata';
import { Worker } from 'bullmq';
import { ProductCardCache } from '../../cache/services/product-card-cache.service';
import { ProductsRepository } from '../../products/repositories/products.repository';
import { openRedisStand } from '../../redis/utils/redis-stand.util';
import { CARD_QUEUE, WARM_EVERY_MS } from '../constants/queue.constant';
import { CardQueue } from '../services/card-queue.service';
import { CardWorker } from '../services/card-worker.service';

/**
 * The process that recomputes product cards.
 *
 *   npm run start:cards
 *
 * The third long-running process beside `start:relay` and `start:worker`, and separate for
 * the same reason: recomputing a card is a join and an aggregate, and a web server that
 * does it inline is a web server whose slowest route is its catalogue.
 *
 * It installs the periodic warmer on the way in. A scheduler belongs to the process that
 * owns the work, and `upsertJobScheduler` means starting a second replica replaces the
 * entry rather than adding a second one — which is what `add` with a repeat option used
 * to do, and why BullMQ 6 removed that API.
 */

const SHUTDOWN_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];

async function main(): Promise<void> {
    const stand = await openRedisStand();

    const cache = new ProductCardCache(stand.cache, new ProductsRepository(stand.dataSource));
    const cards = new CardWorker(cache, stand.dataSource);

    const queue = new CardQueue(stand.queue);
    await queue.scheduleWarming();

    const worker = new Worker(CARD_QUEUE, (job) => cards.process(job), {
        // Its own connection, and `maxRetriesPerRequest: null` on it. A worker blocks on
        // Redis waiting for work; the default retry budget would make it throw while the
        // server was merely restarting, which is the one moment it should be patient.
        connection: stand.blocking(),
        concurrency: 4,
    });

    worker.on('completed', (job) => {
        console.log(`${job.name} ${job.id} done`);
    });
    worker.on('failed', (job, error) => {
        console.error(
            `${job?.name} ${job?.id} failed (attempt ${job?.attemptsMade}): ${error.message}`,
        );
    });

    console.log(`consuming ${CARD_QUEUE}; warming every ${WARM_EVERY_MS / 1000} s`);
    console.log('Ctrl-C or SIGTERM to stop; the job in hand finishes first.\n');

    const reason = await new Promise<string>((resolve) => {
        for (const signal of SHUTDOWN_SIGNALS) {
            process.once(signal, () => resolve(signal));
        }
    });

    console.log(`\n${reason} — finishing the job in hand…`);
    await worker.close();
    await queue.onModuleDestroy();
    await stand.close();

    console.log(
        `stopped. ${cards.tally.refreshed} card(s) refreshed on demand, ` +
            `${cards.tally.warmed} warmed on a schedule.`,
    );
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
