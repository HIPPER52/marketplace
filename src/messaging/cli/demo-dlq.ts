import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { GetMessage } from 'amqplib';
import { Currency } from '../../common/constants/currency.constant';
import { DEMO_BUYER_ID } from '../../users/constants/demo-buyer.constant';
import {
    DELIVERY_LIMIT,
    ORDER_PLACED_DLQ,
    ORDER_PLACED_TYPE,
} from '../constants/topology.constant';
import { OrderPlacedConsumer } from '../services/order-placed-consumer.service';
import type { OrderPlacedEvent } from '../types/order-placed.types';
import { depths, emit, finish, openStand, settleAt } from '../utils/demo-stand.util';
import { deterministicEventId } from '../utils/event-id.util';
import { waitUntil } from '../utils/wait.util';

/**
 * One message that can never be processed, and the contour it leaves through.
 *
 *   npm run demo:dlq
 *
 * The poison is real rather than staged: the event names an order that does not exist, and
 * `order_receipts.order_id` is a foreign key into `orders`. No consumer, on any machine, at
 * any time, can write that receipt — which is what "the work can get stuck forever" means.
 * A handler that threw on a magic value would prove only that the handler can throw.
 *
 * What the run shows is that the failure is **bounded**. Every rejection is
 * `reject(msg, true)`, which returns the message *and* moves the quorum queue's delivery
 * counter; on the delivery past `x-delivery-limit` the broker stops handing it out and
 * dead-letters it instead. `nack(msg, false, true)` would look identical in the code and
 * never increment anything — the message would circle the queue forever, warm and
 * invisible. That single difference is why OrderPlacedConsumer rejects and never nacks.
 *
 * The cause of death is then read back from the message itself. RabbitMQ stamps
 * `x-death` and `x-first-death-*` onto the dead-lettered copy, and there are exactly four
 * reasons it can carry: rejected, expired, maxlen, delivery_limit. Queue TTL is not one of
 * them — a queue that expires takes its messages with it and dead-letters nothing.
 */

async function main(): Promise<void> {
    const stand = await openStand();

    try {
        // ---- the poison ---------------------------------------------------------------
        // An order id drawn at random: nothing in `orders` has it, so the receipt's foreign
        // key refuses the insert on every attempt.
        const orphanOrderId = randomUUID();
        const event: OrderPlacedEvent = {
            eventId: deterministicEventId(ORDER_PLACED_TYPE, orphanOrderId),
            type: ORDER_PLACED_TYPE,
            occurredAt: new Date().toISOString(),
            data: {
                orderId: orphanOrderId,
                userId: DEMO_BUYER_ID,
                totalCents: 1_000,
                currency: Currency.UAH,
            },
        };

        await stand.publisher.publishOrderPlaced(event);

        console.log(`order ${orphanOrderId} does not exist — the receipt cannot be written`);
        console.log(`x-delivery-limit is ${DELIVERY_LIMIT}; every failure is reject(requeue=true)`);
        console.log(
            '\nPostgres will log a failed INSERT below, once per delivery. That is the\n' +
                'demonstration, not a malfunction: it is the foreign key refusing a receipt\n' +
                'for an order that does not exist.\n',
        );

        // ---- the consumer that cannot succeed -----------------------------------------
        const reasons: string[] = [];
        const consumer = new OrderPlacedConsumer(stand.dataSource, stand.channel, {
            onReject: (_message, error) => {
                reasons.push(error instanceof Error ? (error.message.split('\n')[0] ?? '') : '');
            },
        });

        await consumer.start();

        await waitUntil(
            'the message to be dead-lettered',
            async () => (await depths(stand.channel)).dlq >= 1,
            { timeoutMs: 20_000 },
        ).catch(() => {
            // The invariants below report it with the numbers attached.
        });

        await consumer.stop();

        // ---- what the dead-lettered copy says about itself -----------------------------
        const corpse = await stand.channel.get(ORDER_PLACED_DLQ, { noAck: false });
        const reason = corpse === false ? 'none' : deathReason(corpse);
        const deaths = corpse === false ? 0 : deathCount(corpse);

        if (corpse !== false) {
            console.log(`\nx-first-death-reason : ${reason}`);
            console.log(`x-first-death-queue  : ${firstDeathQueue(corpse)}`);
            console.log(`x-death[0].count     : ${deaths}`);
            console.log(`handler said         : ${reasons[0] ?? '(nothing)'}\n`);

            // Put it back: the DLQ is where a human or a redrive process finds it, and
            // `dlq` below is meant to report what is actually sitting there at the end.
            // nack rather than reject — nothing here wants the delivery counted.
            stand.channel.nack(corpse, false, true);
        }

        const left = await settleAt(
            stand.channel,
            { work: 0, dlq: 1 },
            'the dead-lettered message to settle back into the DLQ',
        );

        emit({
            published: stand.publisher.tally.published,
            delivered: consumer.tally.delivered,
            rejected: consumer.tally.rejected,
            effect: consumer.tally.effect,
            work: left.work,
            dlq: left.dlq,
            'dlq-reason': reason,
        });

        // ---- the invariants --------------------------------------------------------------
        const failures: string[] = [];

        if (left.work !== 0) {
            failures.push(
                `the work queue still holds ${left.work} message(s) — a poison message that ` +
                    'never leaves is the failure this demo exists to rule out',
            );
        }

        if (left.dlq !== 1) {
            failures.push(`the dead-letter queue holds ${left.dlq} message(s), expected 1`);
        }

        if (!['rejected', 'expired', 'maxlen', 'delivery_limit'].includes(reason)) {
            failures.push(
                `the dead-lettered message carries no readable cause of death (got ` +
                    `'${reason}') — RabbitMQ has exactly four, and queue TTL is not one`,
            );
        }

        if (consumer.tally.effect !== 0) {
            failures.push(
                `${consumer.tally.effect} receipt(s) were issued for an order that does not ` +
                    'exist, which means the poison was not poisonous',
            );
        }

        if (consumer.tally.rejected <= DELIVERY_LIMIT - 1) {
            failures.push(
                `${consumer.tally.rejected} rejection(s) against a delivery limit of ` +
                    `${DELIVERY_LIMIT} — the message was dead-lettered by something other ` +
                    'than the limit',
            );
        }

        finish(
            failures,
            `a message that can never succeed was retried ${consumer.tally.delivered} times, ` +
                `then\ndead-lettered with reason '${reason}'. The work queue is empty and the ` +
                'cause of\ndeath is readable from the message rather than guessed from a log.',
        );
    } finally {
        await stand.close();
    }
}

interface Death {
    reason?: string;
    queue?: string;
    count?: number;
}

function firstDeath(message: GetMessage): Death {
    const headers = message.properties.headers as Record<string, unknown> | undefined;
    const deaths = headers?.['x-death'];

    return Array.isArray(deaths) ? ((deaths[0] ?? {}) as Death) : {};
}

function deathReason(message: GetMessage): string {
    const headers = message.properties.headers as Record<string, unknown> | undefined;
    const first = headers?.['x-first-death-reason'];

    return typeof first === 'string' ? first : (firstDeath(message).reason ?? 'none');
}

function firstDeathQueue(message: GetMessage): string {
    const headers = message.properties.headers as Record<string, unknown> | undefined;
    const first = headers?.['x-first-death-queue'];

    return typeof first === 'string' ? first : (firstDeath(message).queue ?? 'unknown');
}

function deathCount(message: GetMessage): number {
    return Number(firstDeath(message).count ?? 0);
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
