import 'reflect-metadata';
import { fork } from 'node:child_process';
import { join } from 'node:path';
import { CheckoutOutcome } from '../../orders/constants/outcome.constant';
import { CheckoutService } from '../../orders/services/checkout.service';
import { DEMO_BUYER_ID } from '../../users/constants/demo-buyer.constant';
import { DEMO_PRODUCT_ID } from '../constants/demo.constant';
import { ORDER_RECEIPTS_CONSUMER } from '../constants/topology.constant';
import { OutboxRepository } from '../repositories/outbox.repository';
import { ProcessedMessagesRepository } from '../repositories/processed-messages.repository';
import { OrderPlacedConsumer } from '../services/order-placed-consumer.service';
import { depths, emit, finish, openStand, seedFixture } from '../utils/demo-stand.util';
import { waitUntil } from '../utils/wait.util';
import type { CrashReport } from './crash-relay-child';

/**
 * The heart of the assignment: the service record fails, the event is published twice, and
 * the effect still happens once.
 *
 *   npm run demo:crash-relay
 *
 * A relay has two steps that are not atomic together — hand the row to the broker, then
 * write `published_at`. Here a separate process does the first and is SIGKILLed before the
 * second. Its transaction is abandoned, the row returns to `published_at IS NULL`, and the
 * next pass publishes it again. Two deliveries of one event, caused by **our relay**: no
 * setting in RabbitMQ or Kafka removes it, because neither of them did it.
 *
 * Swapping the two steps does not fix this; it exchanges the failure for a worse one. Mark
 * first and a relay that dies before publishing leaves a row that claims to have been
 * carried out and an event nobody will ever receive. A duplicate is repaired by an
 * idempotent effect. A loss is repaired by nothing, because nothing anywhere records that
 * something is missing.
 *
 * So this is what at-least-once delivery looks like from the inside, and `effect=1` beside
 * `deliveries=2` is what exactly-once actually means: not a delivery guarantee — there is
 * no such thing — but at-least-once delivery plus an effect that cannot count twice.
 */

async function main(): Promise<void> {
    const stand = await openStand();

    try {
        await seedFixture(stand.dataSource);

        // ---- one order, one outbox row ---------------------------------------------------
        const checkout = new CheckoutService(stand.dataSource, new OutboxRepository());
        const result = await checkout.checkout({
            userId: DEMO_BUYER_ID,
            lines: [{ productId: DEMO_PRODUCT_ID, quantity: 1 }],
        });

        if (result.outcome !== CheckoutOutcome.Created) {
            throw new Error(`checkout did not place an order: ${result.outcome}`);
        }

        console.log(`order ${result.orderId} placed; its event is a row in outbox`);

        // ---- pass one: publish, then die -------------------------------------------------
        console.log('forking a relay that publishes the row and is then SIGKILLed…');
        const crashed = await runDoomedRelay();

        if (crashed.signal !== 'SIGKILL') {
            throw new Error(
                `the forked relay ended with code=${crashed.code} signal=${crashed.signal}; ` +
                    'it was supposed to be killed between the publish and the mark',
            );
        }

        const unmarked = await unpublishedCount(stand, result.orderId);
        console.log(
            `the broker has the message; outbox rows still unpublished: ${unmarked}\n` +
                'the relay’s transaction was abandoned, so the mark went with it\n',
        );

        // ---- pass two: the same row, published again ---------------------------------------
        const republished = await stand.relay.drainOnce();
        const published = (crashed.report?.published ?? 0) + republished;

        // ---- the consumer sees both --------------------------------------------------------
        const consumer = new OrderPlacedConsumer(stand.dataSource, stand.channel);
        await consumer.start();

        await waitUntil('both deliveries to be acknowledged', () => consumer.tally.acked >= 2, {
            timeoutMs: 20_000,
        }).catch(() => {
            // Reported below, with the numbers.
        });

        await consumer.stop();
        const left = await depths(stand.channel);

        const applied = await publishedCount(stand, result.orderId);
        const eventIds = await outboxIds(stand, result.orderId);
        const processed = await new ProcessedMessagesRepository(stand.dataSource.manager).countFor(
            ORDER_RECEIPTS_CONSUMER,
            eventIds,
        );

        emit({
            published,
            deliveries: consumer.tally.delivered,
            applied,
            effect: consumer.tally.effect,
            processed,
            skipped: consumer.tally.skipped,
            unmarked,
            work: left.work,
            dlq: left.dlq,
        });

        // ---- the invariants ------------------------------------------------------------------
        const failures: string[] = [];

        if (unmarked !== 1) {
            failures.push(
                `${unmarked} row(s) were left unpublished after the relay died; the mark must ` +
                    'roll back with the transaction that was about to write it',
            );
        }

        if (consumer.tally.delivered < 2) {
            failures.push(
                `${consumer.tally.delivered} delivery(ies) — no duplicate occurred, so this ` +
                    'run demonstrated nothing',
            );
        }

        if (applied !== 1) {
            failures.push(`${applied} outbox row(s) ended up marked as published, expected 1`);
        }

        if (consumer.tally.effect !== 1) {
            failures.push(
                `the effect was applied ${consumer.tally.effect} time(s) across ` +
                    `${consumer.tally.delivered} deliveries`,
            );
        }

        if (processed !== 1) {
            failures.push(`${processed} inbox row(s) for one message, expected 1`);
        }

        if (left.work !== 0 || left.dlq !== 0) {
            failures.push(`queues are not empty: work=${left.work} dlq=${left.dlq}`);
        }

        finish(
            failures,
            `one event, ${published} publishes, ${consumer.tally.delivered} deliveries, ` +
                '1 effect. The duplicate was ours, not the\nbroker’s, and the thing that ' +
                'made it harmless was a primary key — not a\nsetting on a queue.',
        );
    } finally {
        await stand.close();
    }
}

interface DoomedRun {
    report: CrashReport | null;
    code: number | null;
    signal: NodeJS.Signals | null;
}

function runDoomedRelay(): Promise<DoomedRun> {
    return new Promise((resolve, reject) => {
        const child = fork(join(__dirname, 'crash-relay-child.js'), [], {
            stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
        });

        let report: CrashReport | null = null;

        child.on('message', (message) => {
            report = message as CrashReport;
        });
        child.on('error', reject);
        child.on('exit', (code, signal) => {
            resolve({ report, code, signal });
        });
    });
}

interface Stand {
    dataSource: { query: (sql: string, parameters?: unknown[]) => Promise<unknown> };
}

async function unpublishedCount(stand: Stand, aggregateId: string): Promise<number> {
    const rows = (await stand.dataSource.query(
        'SELECT count(*)::int AS n FROM outbox WHERE aggregate_id = $1 AND published_at IS NULL',
        [aggregateId],
    )) as { n: number }[];

    return rows[0]?.n ?? 0;
}

async function publishedCount(stand: Stand, aggregateId: string): Promise<number> {
    const rows = (await stand.dataSource.query(
        'SELECT count(*)::int AS n FROM outbox WHERE aggregate_id = $1 AND published_at IS NOT NULL',
        [aggregateId],
    )) as { n: number }[];

    return rows[0]?.n ?? 0;
}

async function outboxIds(stand: Stand, aggregateId: string): Promise<string[]> {
    const rows = (await stand.dataSource.query('SELECT id FROM outbox WHERE aggregate_id = $1', [
        aggregateId,
    ])) as { id: string }[];

    return rows.map((row) => row.id);
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
