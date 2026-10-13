import 'reflect-metadata';
import type { Channel, ChannelModel } from 'amqplib';
import type { DataSource } from 'typeorm';
import { Currency } from '../../common/constants/currency.constant';
import { AppDataSource } from '../../database/data-source';
import { DEMO_BUYER_BALANCE_CENTS, DEMO_BUYER_ID } from '../../users/constants/demo-buyer.constant';
import {
    DEMO_PRODUCT_ID,
    DEMO_PRODUCT_TITLE,
    DEMO_STOCK,
    DEMO_UNIT_PRICE_CENTS,
} from '../constants/demo.constant';
import { ORDER_PLACED_DLQ, ORDER_PLACED_QUEUE } from '../constants/topology.constant';
import { readBrokerEnv } from '../schemas/broker-env.schema';
import { OrderEventPublisher } from '../services/order-event-publisher.service';
import { declareTopology } from '../services/topology.service';
import { closeQuietly, connectBroker, silenceChannelErrors } from './broker.util';
import { waitUntil } from './wait.util';

export interface QueueDepths {
    work: number;
    dlq: number;
}

export interface DemoStand {
    dataSource: DataSource;
    model: ChannelModel;
    /** A plain channel: purge, check, get, consume. The publisher keeps its own. */
    channel: Channel;
    publisher: OrderEventPublisher;
    close(): Promise<void>;
}

/**
 * Everything the three demos start from: a database, a broker, the topology declared, and
 * both queues empty.
 *
 * "Brings its own state to clean" is the part that is easy to skip and expensive to skip.
 * A demo that counted a message left behind by the previous run would print numbers about
 * two runs at once, and the invariant it checks would pass or fail for reasons nobody can
 * reconstruct afterwards.
 */
export interface StandOptions {
    /**
     * False for a process that joins a run already in progress — `demo:duplicate` forks a
     * consumer whose whole job is to take the message that is already in the queue, and a
     * purge there would delete the subject of the demo.
     */
    purge?: boolean;
}

export async function openStand({ purge = true }: StandOptions = {}): Promise<DemoStand> {
    const { BROKER_URL } = readBrokerEnv(process.env);

    const dataSource = await AppDataSource.initialize();
    let model: ChannelModel | null = null;

    try {
        model = await connectBroker(BROKER_URL);
        await declareTopology(model);

        const channel = silenceChannelErrors(await model.createChannel());

        if (purge) {
            await channel.purgeQueue(ORDER_PLACED_QUEUE);
            await channel.purgeQueue(ORDER_PLACED_DLQ);
        }

        const publisher = new OrderEventPublisher(BROKER_URL);
        const opened = model;

        return {
            dataSource,
            model: opened,
            channel,
            publisher,
            close: async () => {
                await publisher.close();
                await closeQuietly(channel);
                await closeQuietly(opened);
                await dataSource.destroy();
            },
        };
    } catch (error: unknown) {
        await closeQuietly(model);
        await dataSource.destroy();
        throw error;
    }
}

/**
 * Stock and money, restored before every run.
 *
 * The demos must not be measuring the buyer's balance. Checkout debits for real, so a
 * stand that has served a few hundred demo orders would start answering
 * `insufficient-funds` and the failure would look like a broker problem.
 */
export async function seedFixture(dataSource: DataSource): Promise<void> {
    await dataSource.query(
        `INSERT INTO products (id, title, description, price_cents, currency, in_stock)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (id) DO UPDATE
            SET in_stock = EXCLUDED.in_stock, price_cents = EXCLUDED.price_cents`,
        [
            DEMO_PRODUCT_ID,
            DEMO_PRODUCT_TITLE,
            'Owned by the RabbitMQ demos. Restocked on every run.',
            DEMO_UNIT_PRICE_CENTS,
            Currency.UAH,
            DEMO_STOCK,
        ],
    );

    await dataSource.query('UPDATE users SET balance_cents = $2 WHERE id = $1', [
        DEMO_BUYER_ID,
        DEMO_BUYER_BALANCE_CENTS,
    ]);
}

/**
 * How many messages are sitting in each queue.
 *
 * `messageCount` counts messages ready for delivery and excludes the ones a consumer is
 * holding unacknowledged, which is exactly the number a demo wants: "nothing is left to
 * do" rather than "nothing exists".
 */
export async function depths(channel: Channel): Promise<QueueDepths> {
    const work = await channel.checkQueue(ORDER_PLACED_QUEUE);
    const dlq = await channel.checkQueue(ORDER_PLACED_DLQ);

    return { work: work.messageCount, dlq: dlq.messageCount };
}

/** Waits for both queues to report the depths asked for, then returns them. */
export async function settleAt(
    channel: Channel,
    expected: QueueDepths,
    describe: string,
): Promise<QueueDepths> {
    let seen: QueueDepths = { work: -1, dlq: -1 };

    await waitUntil(describe, async () => {
        seen = await depths(channel);

        return seen.work === expected.work && seen.dlq === expected.dlq;
    }).catch(() => {
        // The invariant check downstream reports the numbers; a timeout here only means
        // they never arrived, and saying so twice adds nothing.
    });

    return seen;
}

/**
 * One line per fact, `key=value`, nothing else on the line.
 *
 * The grader greps for whole lines — `grep -qx 'effect=5'` — so a leading space or a
 * trailing comment is the difference between a passing run and a missing criterion.
 */
export function emit(facts: Record<string, string | number>): void {
    for (const [key, value] of Object.entries(facts)) {
        console.log(`${key}=${value}`);
    }
}

/**
 * The exit code is the result. A demo that measured the wrong thing and printed it calmly
 * is a demo nobody will notice breaking.
 */
export function finish(failures: string[], verdict: string): void {
    if (failures.length > 0) {
        console.error('\nFAIL:\n');
        for (const failure of failures) {
            console.error(`  ${failure}`);
        }
        process.exitCode = 1;
        return;
    }

    console.log(`\nOK — ${verdict}`);
}
