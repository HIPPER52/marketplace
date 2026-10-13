import 'reflect-metadata';
import { OrderPlacedConsumer } from '../services/order-placed-consumer.service';
import { openStand } from '../utils/demo-stand.util';

/**
 * A consumer that dies between the effect and the ack.
 *
 * Forked by `demo:duplicate`; never run directly. It takes one delivery, writes the
 * receipt, tells the parent what it did — and then kills itself with SIGKILL before
 * acknowledging anything.
 *
 * SIGKILL to its own pid, and a separate process, because the shape matters. `channel
 * .close()` would also return the message: closing a channel requeues what it holds, and
 * the demo would pass. But a graceful close is not what happens at three in the morning. A
 * process that disappears leaves the operating system to close the socket, the broker sees
 * a connection drop rather than a protocol goodbye, and *that* is the path a redelivery
 * takes in production. Using the easy version would be testing the wrong failure.
 *
 * It does not purge the queues on the way in: the message it is here to take is already
 * sitting in one.
 */

const DELIVERY_TIMEOUT_MS = 20_000;

export interface ChildReport {
    delivered: number;
    effect: number;
    orderId: string;
}

async function main(): Promise<void> {
    const stand = await openStand({ purge: false });

    const giveUp = setTimeout(() => {
        console.error('duplicate-child: no delivery arrived; nothing to lose on purpose');
        process.exit(1);
    }, DELIVERY_TIMEOUT_MS);
    giveUp.unref();

    const consumer = new OrderPlacedConsumer(stand.dataSource, stand.channel, {
        afterEffect: async (event, applied) => {
            await report({
                delivered: consumer.tally.delivered,
                effect: applied ? 1 : 0,
                orderId: event.data.orderId,
            });

            // The receipt is committed. The ack is not sent, and never will be: from the
            // broker's side this is a consumer that vanished holding an unacknowledged
            // delivery, which is exactly the state that causes a redelivery.
            process.kill(process.pid, 'SIGKILL');

            // Unreachable in practice — the signal arrives first. Here so that nothing
            // downstream can run if it ever does not.
            await new Promise<never>(() => {});
        },
    });

    await consumer.start();
}

/** Resolves once the message has actually left this process — SIGKILL flushes nothing. */
function report(payload: ChildReport): Promise<void> {
    return new Promise((resolve, reject) => {
        if (process.send === undefined) {
            resolve();
            return;
        }

        process.send(payload, (error: Error | null) => {
            if (error === null) {
                resolve();
            } else {
                reject(error);
            }
        });
    });
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
