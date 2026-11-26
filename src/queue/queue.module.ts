import { Module } from '@nestjs/common';
import { CardQueue } from './services/card-queue.service';
import { CARD_REFRESH_QUEUE } from './types/card-refresh-queue.types';

/**
 * The producer only.
 *
 * The worker is `npm run start:cards`, its own process — the third of three after the
 * outbox relay and the receipt consumer, and for the same reason each of those is
 * separate: a job that wedges must not be able to stop `/health` from answering.
 */
@Module({
    providers: [CardQueue, { provide: CARD_REFRESH_QUEUE, useExisting: CardQueue }],
    exports: [CardQueue, CARD_REFRESH_QUEUE],
})
export class QueueModule {}
