import 'reflect-metadata';
import { AppDataSource } from '../../database/data-source';
import { RELAY_IDLE_MS } from '../constants/outbox.constant';
import { readBrokerEnv } from '../schemas/broker-env.schema';
import { OrderEventPublisher } from '../services/order-event-publisher.service';
import { OutboxRelay } from '../services/outbox-relay.service';
import { declareTopology } from '../services/topology.service';
import { closeQuietly, connectBroker } from '../utils/broker.util';

/**
 * The process that empties the outbox.
 *
 *   npm run start:relay
 *
 * One of the two halves of the chain that has to be running for an order to become an
 * event somebody hears about; `npm run start:worker` is the other. Neither lives inside
 * the API process, and for the same reason: a courier and a web server scale on different
 * numbers and fail in different ways, and a relay wedged on a slow broker must not be able
 * to stop `/health` from answering.
 *
 * It declares the topology on the way in. That is a bootstrap step rather than a producer
 * declaring what it publishes into — the distinction matters, and the honest reason it is
 * here is that this entry point is the one an operator runs first on a fresh broker.
 *
 * Shutting down is the same shape as the worker's: stop asking for new rows, let the pass
 * in progress finish. A pass interrupted anywhere else rolls back, which leaves its rows
 * unpublished and claimable — the design's own answer, not an accident.
 */

const SHUTDOWN_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];

async function main(): Promise<void> {
    const { BROKER_URL } = readBrokerEnv(process.env);

    const dataSource = await AppDataSource.initialize();
    const model = await connectBroker(BROKER_URL);
    await declareTopology(model);

    const publisher = new OrderEventPublisher(BROKER_URL);
    const relay = new OutboxRelay(dataSource, publisher);

    console.log(`relaying outbox rows every ${RELAY_IDLE_MS} ms when idle`);
    console.log('Ctrl-C or SIGTERM to stop; the pass in flight finishes first.\n');

    const stopping = new Promise<string>((resolve) => {
        for (const signal of SHUTDOWN_SIGNALS) {
            process.once(signal, () => resolve(signal));
        }
    });

    const loop = relay.run();
    const reason = await stopping;

    console.log(`\n${reason} — finishing the current pass…`);
    relay.stop();
    await loop;

    await publisher.close();
    await closeQuietly(model);
    await dataSource.destroy();

    console.log(
        `stopped. ${relay.tally.published} row(s) published, ${relay.tally.marked} marked, ` +
            `${relay.tally.failed} failed, ${relay.tally.pruned} pruned.`,
    );
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
