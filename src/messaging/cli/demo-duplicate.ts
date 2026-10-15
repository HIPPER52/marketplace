import 'reflect-metadata';
import { fork } from 'node:child_process';
import { join } from 'node:path';
import { CheckoutOutcome } from '../../orders/constants/outcome.constant';
import { OrderReceiptsRepository } from '../../orders/repositories/order-receipts.repository';
import { CheckoutService } from '../../orders/services/checkout.service';
import { DEMO_BUYER_ID } from '../../users/constants/demo-buyer.constant';
import { DEMO_PRODUCT_ID } from '../constants/demo.constant';
import { OutboxRepository } from '../repositories/outbox.repository';
import { OrderPlacedConsumer } from '../services/order-placed-consumer.service';
import { depths, emit, finish, openStand, seedFixture, settleAt } from '../utils/demo-stand.util';
import { waitUntil } from '../utils/wait.util';
import type { ChildReport } from './duplicate-child';

/**
 * One event, two deliveries, one effect.
 *
 *   npm run demo:duplicate
 *
 * This is the demo that earns the sentence the rest of the assignment is about:
 * **exactly-once delivery does not exist**, anywhere, for anyone. What exists is
 * at-least-once delivery plus an idempotent effect, and together they produce an
 * exactly-once *result*.
 *
 * The duplicate is caused the way production causes it. A child process takes the
 * delivery, writes the receipt, and is killed with SIGKILL before it acknowledges —
 * `ack` is not "I received this", it is "stop sending me this", and a consumer that dies
 * before saying it has said nothing. The broker sees the connection drop, returns the
 * unacknowledged message to the queue, and hands it to the next consumer. That consumer
 * finds the receipt already there and does nothing, because the effect is expressed
 * through a primary key rather than through an increment.
 *
 * `deliveries=1` would not be a pass with a nicer story — it would mean no redelivery
 * happened and the run proved nothing. The usual cause is `noAck: true`, under which there
 * is nothing left to return.
 */

const QUANTITY = 1;

async function main(): Promise<void> {
    const stand = await openStand();

    try {
        await seedFixture(stand.dataSource);

        // ---- one real order -----------------------------------------------------------
        const checkout = new CheckoutService(stand.dataSource, new OutboxRepository());
        const result = await checkout.checkout({
            userId: DEMO_BUYER_ID,
            lines: [{ productId: DEMO_PRODUCT_ID, quantity: QUANTITY }],
        });

        if (result.outcome !== CheckoutOutcome.Created) {
            throw new Error(`checkout did not place an order: ${result.outcome}`);
        }

        const receipts = new OrderReceiptsRepository(stand.dataSource.manager);
        await receipts.forget([result.orderId]);

        // The checkout wrote a row, not a message. The relay is what hands it over.
        await stand.relay.drainOnce();
        await settleAt(stand.channel, { work: 1, dlq: 0 }, 'the event to reach the queue');
        console.log(`order ${result.orderId} placed; order.placed is in the queue`);

        // ---- delivery one: a consumer that dies holding it ------------------------------
        console.log('forking a consumer that writes the receipt and is then SIGKILLed…');
        const first = await runDoomedConsumer();

        if (first.signal !== 'SIGKILL') {
            throw new Error(
                `the forked consumer ended with code=${first.code} signal=${first.signal}; ` +
                    'it was supposed to be killed mid-delivery',
            );
        }

        // The broker notices the dropped connection and puts the unacknowledged message
        // back. Nothing in this process can make that happen faster, and nothing needs to.
        await settleAt(
            stand.channel,
            { work: 1, dlq: 0 },
            'the broker to return the unacknowledged message',
        );
        console.log('the unacknowledged delivery came back to the queue\n');

        // ---- delivery two: a consumer that finds the work already done -------------------
        const second = new OrderPlacedConsumer(stand.dataSource, stand.channel);
        await second.start();

        await waitUntil('the redelivery to be acknowledged', () => second.tally.acked >= 1, {
            timeoutMs: 20_000,
        }).catch(() => {
            // Reported below with the numbers.
        });

        await second.stop();
        const left = await depths(stand.channel);

        const deliveries = (first.report?.delivered ?? 0) + second.tally.delivered;
        const effect = (first.report?.effect ?? 0) + second.tally.effect;
        const skipped = second.tally.skipped;
        const rows = await receipts.countFor([result.orderId]);

        emit({
            published: stand.relay.tally.published,
            deliveries,
            effect,
            skipped,
            receipts: rows,
            work: left.work,
            dlq: left.dlq,
            prefetch: second.prefetch,
        });

        // ---- the invariants ----------------------------------------------------------------
        const failures: string[] = [];

        if (deliveries < 2) {
            failures.push(
                `${deliveries} delivery(ies) — no duplicate occurred, so this run demonstrated ` +
                    'nothing. Under noAck: true there would be nothing to redeliver',
            );
        }

        if (effect !== 1) {
            failures.push(
                `the effect was applied ${effect} time(s) across ${deliveries} deliveries; ` +
                    'at-least-once delivery only becomes an exactly-once result if the ' +
                    'effect is idempotent',
            );
        }

        if (rows !== 1) {
            failures.push(`order_receipts holds ${rows} row(s) for one order, expected 1`);
        }

        if (left.work !== 0 || left.dlq !== 0) {
            failures.push(`queues are not empty: work=${left.work} dlq=${left.dlq}`);
        }

        finish(
            failures,
            `one event, ${deliveries} deliveries, ${effect} effect. The duplicate was real — ` +
                'a consumer\ndied after writing and before acknowledging — and the primary key ' +
                'on\norder_receipts is the entire reason it cost nothing.',
        );
    } finally {
        await stand.close();
    }
}

interface DoomedRun {
    report: ChildReport | null;
    code: number | null;
    signal: NodeJS.Signals | null;
}

/**
 * Runs the child and waits for it to die.
 *
 * It reports over IPC rather than by writing a row, because the point of the exercise is
 * what the *broker* does with an unacknowledged delivery — and the child has to be able to
 * say "I applied the effect" before it is in a position to prove it.
 */
function runDoomedConsumer(): Promise<DoomedRun> {
    return new Promise((resolve, reject) => {
        const child = fork(join(__dirname, 'duplicate-child.js'), [], {
            stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
        });

        let report: ChildReport | null = null;

        child.on('message', (message) => {
            report = message as ChildReport;
        });
        child.on('error', reject);
        child.on('exit', (code, signal) => {
            resolve({ report, code, signal });
        });
    });
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
