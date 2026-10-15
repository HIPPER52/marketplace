import 'reflect-metadata';
import { CheckoutOutcome } from '../../orders/constants/outcome.constant';
import { CheckoutService } from '../../orders/services/checkout.service';
import { DEMO_BUYER_ID } from '../../users/constants/demo-buyer.constant';
import { DEMO_PRODUCT_ID } from '../constants/demo.constant';
import { OutboxRepository } from '../repositories/outbox.repository';
import { OrderPlacedConsumer } from '../services/order-placed-consumer.service';
import { depths, emit, finish, openStand, seedFixture, settleAt } from '../utils/demo-stand.util';
import { waitUntil } from '../utils/wait.util';

/**
 * Five orders, five events, five effects — the happy path end to end.
 *
 *   npm run demo:publish
 *
 * The five events are published by five real checkouts, not by a loop calling the
 * publisher: the assignment asks for the event to leave the critical business operation,
 * and the honest way to show that is to perform the business operation. Each one moves
 * stock, debits the buyer, writes an order and only then announces it.
 *
 * Nothing is subscribed while they are published, which is the difference this whole
 * assignment is about. In #18 a WebSocket delivered to whoever happened to be connected —
 * no receiver, no delivery. Here the five messages sit in a durable queue (`buffered=5`
 * below) until a consumer arrives, and then every one of them is carried out.
 *
 * Since #22 the checkouts do not publish anything. Each one writes an `outbox` row in its
 * own transaction and the relay carries the five rows over afterwards — which is why the
 * drain below sits between the orders and the queue. The numbers are unchanged, and that
 * is the point: the delivery guarantee did not move, only the thing that can lose it.
 */

const ORDERS = 5;
const QUANTITY = 1;

async function main(): Promise<void> {
    const stand = await openStand();

    try {
        await seedFixture(stand.dataSource);

        // ---- the business operation, five times -------------------------------------
        const checkout = new CheckoutService(stand.dataSource, new OutboxRepository());
        const results = await Promise.all(
            Array.from({ length: ORDERS }, () =>
                checkout.checkout({
                    userId: DEMO_BUYER_ID,
                    lines: [{ productId: DEMO_PRODUCT_ID, quantity: QUANTITY }],
                }),
            ),
        );

        const created = results.filter((result) => result.outcome === CheckoutOutcome.Created);
        const orderIds = created.map((result) => result.orderId);

        // ---- the relay carries the rows across -----------------------------------------
        await stand.relay.drainOnce();

        // ---- what the broker is holding before anyone subscribes ----------------------
        const buffered = await settleAt(
            stand.channel,
            { work: ORDERS, dlq: 0 },
            `${ORDERS} messages to be sitting in the queue`,
        );

        // ---- the consumer -------------------------------------------------------------
        const consumer = new OrderPlacedConsumer(stand.dataSource, stand.channel);
        await consumer.start();

        await waitUntil('every delivery to be acknowledged', () => consumer.tally.acked >= ORDERS, {
            timeoutMs: 20_000,
        }).catch(() => {
            // Reported by the invariants below, with the numbers attached.
        });

        await consumer.stop();
        const left = await depths(stand.channel);

        // ---- the report ----------------------------------------------------------------
        emit({
            published: stand.relay.tally.published,
            buffered: buffered.work,
            delivered: consumer.tally.delivered,
            effect: consumer.tally.effect,
            skipped: consumer.tally.skipped,
            acked: consumer.tally.acked,
            work: left.work,
            dlq: left.dlq,
            prefetch: consumer.prefetch,
        });

        // ---- the invariants --------------------------------------------------------------
        const failures: string[] = [];

        if (created.length !== ORDERS) {
            failures.push(
                `${created.length} of ${ORDERS} checkouts succeeded — the fixture is wrong, ` +
                    'not the broker',
            );
        }

        if (stand.relay.tally.published !== ORDERS) {
            failures.push(
                `the relay carried ${stand.relay.tally.published} of ${ORDERS} outbox rows ` +
                    'to the broker',
            );
        }

        if (buffered.work !== ORDERS) {
            failures.push(
                `the queue held ${buffered.work} messages before anyone subscribed, not ` +
                    `${ORDERS} — a confirm that routed nowhere looks exactly like this`,
            );
        }

        if (consumer.tally.effect !== ORDERS) {
            failures.push(
                `${consumer.tally.effect} receipts were issued for ${orderIds.length} orders`,
            );
        }

        if (consumer.tally.acked !== consumer.tally.delivered) {
            failures.push(
                `${consumer.tally.delivered} deliveries, ${consumer.tally.acked} acks — a ` +
                    'delivery nobody acknowledged comes back when the connection drops',
            );
        }

        if (left.work !== 0 || left.dlq !== 0) {
            failures.push(`queues are not empty: work=${left.work} dlq=${left.dlq}`);
        }

        finish(
            failures,
            `${ORDERS} events published with confirms, held by the broker with nobody ` +
                `listening,\nthen delivered to a consumer with prefetch=${consumer.prefetch} ` +
                'and acknowledged after the effect.',
        );
    } finally {
        await stand.close();
    }
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
