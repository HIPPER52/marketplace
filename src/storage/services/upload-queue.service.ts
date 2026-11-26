import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import type Redis from 'ioredis';
import { REDIS_QUEUE } from '../../redis/constants/redis.constants';
import {
    REAP_EVERY_MS,
    REAP_JOB_OPTIONS,
    REAP_QUEUE,
    REAP_SCHEDULER,
    ReaperJob,
} from '../constants/reaper.constant';

/**
 * The producer side of the maintenance queue: one periodic sweep, and nothing else.
 *
 * `upsertJobScheduler` rather than `add` with a repeat option — the repeatable API was
 * removed in BullMQ 6, and upsert means a second replica starting replaces the entry
 * instead of adding a second one that fires at the same instant.
 */
@Injectable()
export class UploadQueue implements OnModuleDestroy {
    private readonly queue: Queue;

    constructor(@Inject(REDIS_QUEUE) connection: Redis) {
        this.queue = new Queue(REAP_QUEUE, { connection });
    }

    async scheduleSweeps(): Promise<void> {
        await this.queue.upsertJobScheduler(
            REAP_SCHEDULER,
            { every: REAP_EVERY_MS },
            { name: ReaperJob.Abandoned, opts: REAP_JOB_OPTIONS },
        );
    }

    async onModuleDestroy(): Promise<void> {
        await this.queue.close();
    }
}
