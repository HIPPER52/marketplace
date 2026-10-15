import 'reflect-metadata';
import type { EntityManager } from 'typeorm';
import { CheckoutService } from '../../orders/services/checkout.service';
import { DEMO_BUYER_ID } from '../../users/constants/demo-buyer.constant';
import { DEMO_PRODUCT_ID } from '../constants/demo.constant';
import { OutboxRepository, type OutboxWriter } from '../repositories/outbox.repository';
import { OrderPlacedConsumer } from '../services/order-placed-consumer.service';
import type { NewOutboxRecord } from '../types/outbox.types';
import { emit, finish, openStand, seedFixture } from '../utils/demo-stand.util';
import { sleep } from '../utils/wait.util';

/**
 * The losing side of the COMMIT: the business write fails *after* the outbox row exists.
 *
 *   npm run demo:crash-write
 *
 * This is the half of "the write failed" that proves the two rows really are one write. The
 * transaction inserts the order, inserts the announcement beside it, and is then refused.
 * Both rows disappear together, the relay finds nothing to carry, and no consumer ever
 * hears that an order was placed — because one was not.
 *
 * It is worth being precise about what this rules out. Under dual write the mirror image
 * is possible: a publish that succeeded while the transaction rolled back, leaving an
 * event about an order that does not exist. Consumers then act on a phantom, and nothing
 * in the database can be queried to discover it. An outbox row cannot survive its own
 * transaction, so that failure is not merely unlikely here — it is unavailable.
 *
 * The failure is injected through a seam rather than a flag inside CheckoutService:
 * production passes `OutboxRepository`, this demo passes a writer that appends the row and
 * then refuses. The class under test is the one that ships.
 */

/** Writes the row, then fails — inside the transaction, after the INSERT. */
class RefusingOutboxWriter implements OutboxWriter {
    constructor(private readonly real: OutboxWriter) {}

    async append(manager: EntityManager, record: NewOutboxRecord): Promise<void> {
        await this.real.append(manager, record);

        throw new Error('simulated failure of the business write, after the outbox INSERT');
    }
}

async function main(): Promise<void> {
    const stand = await openStand();

    try {
        await seedFixture(stand.dataSource);

        const before = {
            orders: await count(stand, 'orders'),
            outbox: await count(stand, 'outbox'),
        };

        // ---- the write that fails -------------------------------------------------------
        const checkout = new CheckoutService(
            stand.dataSource,
            new RefusingOutboxWriter(new OutboxRepository()),
        );

        console.log('placing an order whose transaction fails after the outbox INSERT…');
        console.log(
            '\nPostgres and TypeORM will log the rolled-back transaction below. That is\n' +
                'the demonstration, not a malfunction.\n',
        );

        let writeFailed = 0;

        try {
            await checkout.checkout({
                userId: DEMO_BUYER_ID,
                lines: [{ productId: DEMO_PRODUCT_ID, quantity: 1 }],
            });
        } catch {
            writeFailed = 1;
        }

        const after = {
            orders: await count(stand, 'orders'),
            outbox: await count(stand, 'outbox'),
        };

        // ---- nothing left to carry, and nobody to tell ------------------------------------
        const published = await stand.relay.drainOnce();

        const consumer = new OrderPlacedConsumer(stand.dataSource, stand.channel);
        await consumer.start();
        await sleep(500);
        await consumer.stop();

        emit({
            'write-failed': writeFailed,
            orders: after.orders - before.orders,
            outbox: after.outbox - before.outbox,
            published,
            deliveries: consumer.tally.delivered,
            effect: consumer.tally.effect,
        });

        // ---- the invariants ----------------------------------------------------------------
        const failures: string[] = [];

        if (writeFailed !== 1) {
            failures.push('the transaction was supposed to fail and did not');
        }

        if (after.orders !== before.orders) {
            failures.push(`${after.orders - before.orders} order(s) survived a failed transaction`);
        }

        if (after.outbox !== before.outbox) {
            failures.push(
                `${after.outbox - before.outbox} outbox row(s) survived the transaction that ` +
                    'wrote them — the two writes are not sharing a COMMIT',
            );
        }

        if (published !== 0) {
            failures.push(`the relay carried ${published} row(s) out of an empty outbox`);
        }

        if (consumer.tally.delivered !== 0 || consumer.tally.effect !== 0) {
            failures.push(
                `a consumer saw ${consumer.tally.delivered} delivery(ies) and applied ` +
                    `${consumer.tally.effect} effect(s) for an order that was never placed`,
            );
        }

        finish(
            failures,
            'the transaction failed after the outbox row existed, and the row went with\n' +
                'the order. An event here cannot outlive the business write that produced\n' +
                'it, because there is only one write.',
        );
    } finally {
        await stand.close();
    }
}

async function count(
    stand: { dataSource: { query: (sql: string) => Promise<unknown> } },
    table: string,
): Promise<number> {
    const rows = (await stand.dataSource.query(`SELECT count(*)::int AS n FROM ${table}`)) as {
        n: number;
    }[];

    return rows[0]?.n ?? 0;
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
