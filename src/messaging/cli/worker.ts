import 'reflect-metadata';
import { AppDataSource } from '../../database/data-source';
import { ORDER_PLACED_QUEUE } from '../constants/topology.constant';
import { readBrokerEnv } from '../schemas/broker-env.schema';
import { OrderPlacedConsumer } from '../services/order-placed-consumer.service';
import { declareTopology } from '../services/topology.service';
import { closeQuietly, connectBroker, silenceChannelErrors } from '../utils/broker.util';

/**
 * The process that drains `shop.order-placed`.
 *
 *   npm run start:worker
 *
 * Without this there is nobody: the three demos each raise a consumer for the length of
 * one run, and the API process deliberately does not subscribe — two subscribers on one
 * queue would mean a demo's numbers depended on which process won the race. A queue that
 * only a demo ever empties is a queue that fills up in a deployment, so the consumer needs
 * an entry point of its own. This is it, and it is the same `OrderPlacedConsumer` the
 * demos exercise — one implementation, two ways of starting it.
 *
 * It is a separate process rather than a flag on the API for the ordinary reason: a
 * consumer and an HTTP service scale on different numbers and fail in different ways. Ten
 * API replicas behind a load balancer do not imply ten consumers, and a consumer wedged on
 * a slow handler must not be able to stop answering `/health`.
 *
 * ## Shutting down is the interesting half
 *
 * On SIGTERM — which is what a container orchestrator sends — the consumer is cancelled
 * first, so no new delivery arrives, and only then does the process wait for the
 * deliveries already in hand. Anything still unacknowledged at that point goes back to the
 * queue, because an ack is "stop sending me this" and this process is in no position to
 * say it any more.
 *
 * That is the exact opposite of `demo:duplicate`, which SIGKILLs a consumer to show what
 * an *ungraceful* exit costs. Both end with the message back in the queue; only one of
 * them leaves the work half-done, and the difference is this function.
 */

const SHUTDOWN_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];

async function main(): Promise<void> {
    const { BROKER_URL } = readBrokerEnv(process.env);

    const dataSource = await AppDataSource.initialize();
    const model = await connectBroker(BROKER_URL);

    // The consumer declares the topology, here as everywhere — the publisher only ever
    // names an exchange and a routing key.
    await declareTopology(model);

    const channel = silenceChannelErrors(await model.createChannel());
    const consumer = new OrderPlacedConsumer(dataSource, channel, {
        afterEffect: (event, applied) => {
            console.log(
                applied
                    ? `receipt issued for order ${event.data.orderId}`
                    : `order ${event.data.orderId} already has a receipt — redelivery, no effect`,
            );
        },
        onReject: (_message, error) => {
            console.error(
                `delivery rejected and returned: ${
                    error instanceof Error ? error.message.split('\n')[0] : String(error)
                }`,
            );
        },
    });

    await consumer.start();
    console.log(`consuming ${ORDER_PLACED_QUEUE} with prefetch=${consumer.prefetch}`);
    console.log('Ctrl-C or SIGTERM to stop; deliveries in hand are finished first.\n');

    const reason = await untilStopped(model);
    console.log(`\n${reason} — cancelling the subscription and finishing what is in hand…`);

    await consumer.stop();
    await closeQuietly(channel);
    await closeQuietly(model);
    await dataSource.destroy();

    console.log(
        `stopped. ${consumer.tally.effect} receipt(s) issued, ` +
            `${consumer.tally.skipped} redelivery(ies) skipped, ` +
            `${consumer.tally.rejected} rejection(s) returned to the queue.`,
    );
}

/**
 * Resolves on the first shutdown signal, or rejects if the broker goes away.
 *
 * A dropped connection is not something to survive quietly: the messages this process was
 * holding have gone back to the queue, and the honest response is to exit non-zero and let
 * whatever started it start it again — with a fresh connection and a fresh channel.
 */
function untilStopped(model: {
    on(event: 'close', listener: () => void): unknown;
}): Promise<string> {
    return new Promise((resolve, reject) => {
        let settled = false;

        for (const signal of SHUTDOWN_SIGNALS) {
            process.once(signal, () => {
                if (settled) {
                    // A second Ctrl-C means the operator is no longer asking politely.
                    process.exit(130);
                }

                settled = true;
                resolve(signal);
            });
        }

        model.on('close', () => {
            if (!settled) {
                settled = true;
                reject(new Error('the broker connection closed'));
            }
        });
    });
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
