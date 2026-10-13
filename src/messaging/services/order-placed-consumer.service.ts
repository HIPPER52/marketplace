import type { Channel, ConsumeMessage } from 'amqplib';
import type { DataSource } from 'typeorm';
import { OrderReceiptsRepository } from '../../orders/repositories/order-receipts.repository';
import { ORDER_PLACED_QUEUE, PREFETCH } from '../constants/topology.constant';
import type { OrderPlacedEvent } from '../types/order-placed.types';

export interface ConsumerTally {
    /** Deliveries this consumer received, redeliveries included. */
    delivered: number;
    /** Deliveries whose effect was actually applied. */
    effect: number;
    /** Deliveries that found the effect already applied and did nothing. */
    skipped: number;
    acked: number;
    rejected: number;
}

export interface ConsumerOptions {
    prefetch?: number;
    /**
     * Runs after the effect is written and before the ack, which is the window where a
     * consumer that dies causes a redelivery of work that was already done. `demo:duplicate`
     * dies here on purpose; nothing else passes this.
     */
    afterEffect?: (event: OrderPlacedEvent, applied: boolean) => void | Promise<void>;
    /** Where a rejected delivery is reported. Demos print it; the default says nothing. */
    onReject?: (message: ConsumeMessage, error: unknown) => void;
}

/**
 * Reads `order.placed` and issues the receipt.
 *
 * Three decisions, and all three are the difference between this and a consumer that
 * looks the same and loses work:
 *
 *   - **`noAck: false`, and the ack comes after the effect.** An ack is not "the message
 *     arrived"; it is "do not send this to me again". Acknowledging on receipt — which is
 *     what `noAck: true` does, at the moment of delivery — is a promise the consumer has
 *     not yet earned, and a process that dies a millisecond later took the work with it
 *     and nobody is told.
 *   - **`prefetch`, with a number.** The default is 0 and 0 means unlimited: the first
 *     consumer to subscribe is handed every message in the queue, and a second one gets
 *     nothing until the first is done. See PREFETCH for how the number was chosen.
 *   - **`reject`, never `nack`.** Both return the message. Only `reject(msg, true)`
 *     increments the quorum queue's delivery counter, so only it runs into
 *     `x-delivery-limit` and ends in the dead-letter exchange. `nack(msg, false, true)`
 *     leaves the counter where it is: the message comes back forever, and a poison message
 *     becomes a permanent load on the cluster rather than a row in a DLQ.
 *
 * The handler makes no attempt to tell a transient failure from a permanent one. It cannot
 * — a foreign key violation and a dropped connection both arrive as a rejected promise —
 * and the delivery limit is what makes the distinction unnecessary: a transient failure
 * succeeds within three tries, a permanent one is dead-lettered with the reason attached.
 */
export class OrderPlacedConsumer {
    readonly tally: ConsumerTally = {
        delivered: 0,
        effect: 0,
        skipped: 0,
        acked: 0,
        rejected: 0,
    };

    readonly prefetch: number;

    private consumerTag: string | null = null;
    private readonly inFlight = new Set<Promise<void>>();

    constructor(
        private readonly dataSource: DataSource,
        private readonly channel: Channel,
        private readonly options: ConsumerOptions = {},
    ) {
        this.prefetch = options.prefetch ?? PREFETCH;
    }

    async start(): Promise<void> {
        // Per consumer, not per channel: `global: true` would share one window across every
        // consumer on the channel, which is a different and almost never wanted thing.
        await this.channel.prefetch(this.prefetch, false);

        const { consumerTag } = await this.channel.consume(
            ORDER_PLACED_QUEUE,
            (message) => {
                // null is the server cancelling the subscription — the queue was deleted,
                // or consumer_timeout fired. There is nothing to ack and nothing to do but
                // stop pretending to be subscribed.
                if (message === null) {
                    this.consumerTag = null;
                    return;
                }

                const work = this.handle(message).finally(() => {
                    this.inFlight.delete(work);
                });
                this.inFlight.add(work);
            },
            { noAck: false },
        );

        this.consumerTag = consumerTag;
    }

    /** Stops taking new deliveries and waits for the ones already in hand. */
    async stop(): Promise<void> {
        if (this.consumerTag !== null) {
            await this.channel.cancel(this.consumerTag);
            this.consumerTag = null;
        }

        await Promise.all([...this.inFlight]);
    }

    private async handle(message: ConsumeMessage): Promise<void> {
        this.tally.delivered += 1;

        try {
            const event = parseEvent(message.content);
            const receipts = new OrderReceiptsRepository(this.dataSource.manager);

            const applied = await receipts.issue({
                orderId: event.data.orderId,
                eventId: event.eventId,
                totalCents: event.data.totalCents,
                currency: event.data.currency,
            });

            if (applied) {
                this.tally.effect += 1;
            } else {
                this.tally.skipped += 1;
            }

            await this.options.afterEffect?.(event, applied);

            this.channel.ack(message);
            this.tally.acked += 1;
        } catch (error: unknown) {
            this.tally.rejected += 1;
            this.options.onReject?.(message, error);

            // requeue: true — see the class note. This is the call that moves
            // x-delivery-count, and therefore the call that can ever reach the DLQ.
            this.channel.reject(message, true);
        }
    }
}

function parseEvent(content: Buffer): OrderPlacedEvent {
    const parsed: unknown = JSON.parse(content.toString('utf8'));

    if (
        typeof parsed !== 'object' ||
        parsed === null ||
        typeof (parsed as OrderPlacedEvent).eventId !== 'string' ||
        typeof (parsed as OrderPlacedEvent).data?.orderId !== 'string'
    ) {
        throw new Error('not an order.placed envelope');
    }

    return parsed as OrderPlacedEvent;
}
