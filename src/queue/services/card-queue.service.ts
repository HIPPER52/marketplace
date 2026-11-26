import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import type Redis from 'ioredis';
import { REDIS_QUEUE } from '../../redis/constants/redis.constants';
import {
    CARD_JOB_OPTIONS,
    CARD_QUEUE,
    CardJob,
    WARM_EVERY_MS,
    WARM_SCHEDULER,
} from '../constants/queue.constant';
import type { CardRefreshQueue } from '../types/card-refresh-queue.types';

/**
 * The producer side of the card queue.
 *
 * What goes in here is work that must happen but must not happen *inside* an HTTP request:
 * recomputing a card is a join and an aggregate, and the customer who just placed an order
 * should not wait for it.
 *
 * **Enqueueing is best effort, and that is a design decision rather than laziness.** The
 * cache has a TTL on every entry, so a refresh that never happens costs staleness bounded
 * by five minutes — explicit invalidation is an optimisation layered on an expiry, never a
 * replacement for one. This is the opposite of the outbox in #22, where losing the write
 * would have lost a fact; here the fact is in Postgres and the queue only makes the cache
 * notice sooner.
 */
@Injectable()
export class CardQueue implements CardRefreshQueue, OnModuleDestroy {
    private readonly logger = new Logger(CardQueue.name);
    private readonly queue: Queue;

    constructor(@Inject(REDIS_QUEUE) connection: Redis) {
        this.queue = new Queue(CARD_QUEUE, { connection });
    }

    /**
     * Asks for one card to be recomputed.
     *
     * `jobId` is derived from the product, so two orders for the same item while the first
     * refresh is still waiting produce **one** job rather than two identical ones. That is
     * deduplication by natural key, the same idea as the receipt's primary key in #19 —
     * applied to work instead of to an effect.
     */
    async refresh(productId: string): Promise<void> {
        try {
            await this.queue.add(
                CardJob.Refresh,
                { productId },
                // '-' and not ':': BullMQ builds its own key names with a colon and refuses a
                // custom id that contains one.
                { ...CARD_JOB_OPTIONS, jobId: `${CardJob.Refresh}-${productId}` },
            );
        } catch (error: unknown) {
            this.logger.warn(
                `could not queue a refresh for ${productId}; the TTL will catch it: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }

    /**
     * Installs the periodic warmer.
     *
     * `upsertJobScheduler` and not `add`: a scheduler is identified by its name, so a
     * restart replaces the existing one instead of adding a second. The repeatable-job API
     * that half the internet still teaches was removed in BullMQ 6.
     */
    async scheduleWarming(everyMs: number = WARM_EVERY_MS): Promise<void> {
        await this.queue.upsertJobScheduler(
            WARM_SCHEDULER,
            { every: everyMs },
            { name: CardJob.Warm, opts: CARD_JOB_OPTIONS },
        );
    }

    onModuleDestroy(): Promise<void> {
        return this.queue.close();
    }
}
