import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { PlaceOrderOutcome } from '../../orders/constants/outcome.constant';
import { ORDER_RECEIPTS_CONSUMER } from '../constants/topology.constant';
import { ProcessedMessagesRepository } from '../repositories/processed-messages.repository';
import { OrderPlacedConsumer } from '../services/order-placed-consumer.service';
import { oneItemOrder, placeOrderService } from '../utils/demo-orders.util';
import { depths, emit, finish, openStand, seedFixture } from '../utils/demo-stand.util';
import { waitUntil } from '../utils/wait.util';

/**
 * The happy path, end to end — and the one key that holds it together.
 *
 *   npm run demo:outbox
 *
 * Two requests carry the same `Idempotency-Key`. One order is placed, one `outbox` row is
 * written by the same transaction, the relay carries it over once, the consumer applies
 * one effect and records one mark. Six numbers, and each of them is a different mechanism
 * answering the same question: how many times did this actually happen?
 *
 *   requests=2   what the caller asked for
 *   orders=1     level three — the key identifies the intent, not the attempt
 *   outbox=1     one COMMIT wrote the order and its announcement together
 *   published=1  the relay carried the row across once
 *   effect=1     level one — the receipt's primary key is the order
 *   processed=1  level two — the inbox row and the effect share a transaction
 *
 * The second request never reaches checkout. `INSERT … ON CONFLICT DO NOTHING` on the key
 * says the reservation is already held, and the reservation already names an order, so the
 * answer is a replay. The key was reserved *before* the first checkout ran, which is what
 * makes that true for two simultaneous requests and not only for two sequential ones.
 */

async function main(): Promise<void> {
    const stand = await openStand();

    try {
        await seedFixture(stand.dataSource);

        // ---- two requests, one key ----------------------------------------------------
        const placeOrder = placeOrderService(stand.dataSource);
        const key = `demo-outbox-${randomUUID()}`;
        const body = oneItemOrder();

        const first = await placeOrder.place({ key, body });
        const second = await placeOrder.place({ key, body });

        const requests = 2;
        const outcomes = [first, second];
        const orders = new Set(
            outcomes
                .filter(
                    (o) =>
                        o.outcome === PlaceOrderOutcome.Created ||
                        o.outcome === PlaceOrderOutcome.Replayed,
                )
                .map((o) => (o as { orderId: string }).orderId),
        );
        const created = outcomes.filter((o) => o.outcome === PlaceOrderOutcome.Created).length;

        if (first.outcome !== PlaceOrderOutcome.Created) {
            throw new Error(`the first request did not place an order: ${first.outcome}`);
        }

        console.log(`request 1: ${first.outcome}`);
        console.log(`request 2: ${second.outcome}  (same Idempotency-Key)`);
        console.log(`order:     ${first.orderId}\n`);

        // ---- what the business transaction left behind ---------------------------------
        const rows = await stand.dataSource.query<{ id: string }[]>(
            'SELECT id FROM outbox WHERE aggregate_id = $1',
            [first.orderId],
        );
        const eventIds = rows.map((row) => row.id);

        // ---- the relay, then the consumer -----------------------------------------------
        const published = await stand.relay.drainOnce();

        const consumer = new OrderPlacedConsumer(stand.dataSource, stand.channel);
        await consumer.start();

        await waitUntil('the delivery to be acknowledged', () => consumer.tally.acked >= 1, {
            timeoutMs: 20_000,
        }).catch(() => {
            // Reported below, with the numbers.
        });

        await consumer.stop();
        const left = await depths(stand.channel);

        const processed = await new ProcessedMessagesRepository(stand.dataSource.manager).countFor(
            ORDER_RECEIPTS_CONSUMER,
            eventIds,
        );

        emit({
            requests,
            orders: orders.size,
            outbox: eventIds.length,
            published,
            deliveries: consumer.tally.delivered,
            effect: consumer.tally.effect,
            processed,
            work: left.work,
            dlq: left.dlq,
        });

        // ---- the invariants ----------------------------------------------------------------
        const failures: string[] = [];

        if (created !== 1 || orders.size !== 1) {
            failures.push(
                `${requests} requests with one key produced ${created} checkout(s) and ` +
                    `${orders.size} order(s) — the key identifies the intent, so there must ` +
                    'be exactly one of each',
            );
        }

        if (eventIds.length !== 1) {
            failures.push(
                `${eventIds.length} outbox row(s) for one order; the announcement is written ` +
                    'by the same transaction, once',
            );
        }

        if (published !== 1) {
            failures.push(`the relay carried ${published} row(s), expected 1`);
        }

        if (consumer.tally.effect !== 1) {
            failures.push(`the effect was applied ${consumer.tally.effect} time(s), expected 1`);
        }

        if (processed !== 1) {
            failures.push(`${processed} inbox row(s) for one message, expected 1`);
        }

        if (left.work !== 0 || left.dlq !== 0) {
            failures.push(`queues are not empty: work=${left.work} dlq=${left.dlq}`);
        }

        finish(
            failures,
            'two requests with one key became one order, one outbox row, one publish,\n' +
                'one effect and one inbox mark. Three different mechanisms, each refusing\n' +
                'to count the same thing twice.',
        );
    } finally {
        await stand.close();
    }
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
