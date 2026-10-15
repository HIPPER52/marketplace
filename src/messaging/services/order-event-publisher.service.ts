import type { ChannelModel, ConfirmChannel } from 'amqplib';
import { EVENTS_EXCHANGE } from '../constants/topology.constant';
import { closeQuietly, connectBroker, silenceChannelErrors } from '../utils/broker.util';

/**
 * What the publisher needs to know about a message, and nothing more.
 *
 * Shaped like an outbox row on purpose: the relay reads rows and hands them straight here,
 * so there is no step that could invent a routing key the stored row did not ask for.
 */
export interface PublishableRecord {
    /** The message id. Stable across republishes, which is what makes a duplicate free. */
    id: string;
    /** The event type, which is also the routing key. */
    type: string;
    payload: Record<string, unknown>;
}

const APP_ID = 'marketplace-api';

/**
 * The one place a message leaves this process.
 *
 * Since #22 its caller is the relay rather than checkout: the business transaction writes
 * an outbox row and knows nothing about a broker. What the relay hands over is that row,
 * which is why this takes a record rather than a domain event.
 *
 * Two things make "published" mean something here, and without either of them it means
 * only "handed to a socket":
 *
 *   - **a confirm channel, awaited per message.** The publish resolves when the broker has
 *     taken responsibility for *this* message. Until then a publish is a write to a
 *     buffer, and a broker that dies in between took the event with it.
 *   - **`mandatory: true` and a listener for the return.** A confirm is not a delivery.
 *     If no binding matches the routing key, the broker discards the message and answers
 *     the publisher with a *positive* confirm — its responsibility for an unroutable
 *     message is precisely to throw it away. Without `mandatory` there is no error, no
 *     log and no dead-letter: the dead-letter exchange lives on a queue, and the message
 *     never reached one. With it, the broker hands the message back first, and the two
 *     arrive in that order by protocol — basic.return precedes the basic.ack for the same
 *     message, and amqplib processes frames in order — so the 'return' listener has
 *     already run by the time this message's confirm callback does, which is what makes
 *     the check below sound rather than hopeful.
 *
 * The connection is opened on the first publish rather than in the constructor. The HTTP
 * service must come up whether or not a broker is reachable: the order is already
 * committed by the time this is called, and refusing to answer the customer because a
 * notification could not be sent would be trading a real failure for a worse one.
 */
export class OrderEventPublisher {
    /**
     * Confirmed publishes. Incremented after waitForConfirms and after the unroutable
     * check, so it counts messages the broker took responsibility for and routed — not
     * messages handed to a socket. `demo:publish` prints this number rather than counting
     * its own calls, because checkout swallows a publish failure by design and a demo that
     * reported its intentions would print `published=5` on a run that published nothing.
     */
    readonly tally = { published: 0 };

    private model: ChannelModel | null = null;
    private channel: ConfirmChannel | null = null;
    private opening: Promise<ConfirmChannel> | null = null;

    /** Message ids the broker handed back as unroutable, drained by the publish that sees them. */
    private readonly returned = new Set<string>();

    constructor(private readonly url: string) {}

    /**
     * Throws when the event did not reach a queue, for any reason. The caller decides what
     * that is worth — checkout logs it and still answers the customer, a demo fails the
     * process.
     */
    async publish(record: PublishableRecord): Promise<void> {
        const channel = await this.ready();

        this.returned.delete(record.id);

        // Per-message, not `waitForConfirms()`.
        //
        // `waitForConfirms()` resolves when *every* publish outstanding on the channel has
        // been confirmed, and the channel is shared by every concurrent checkout. One slow
        // confirm would therefore hold up orders it has nothing to do with: five checkouts
        // at once would all wait for the slowest. The callback form of `publish` is handed
        // to this message's own confirm and nobody else's.
        await new Promise<void>((resolve, reject) => {
            channel.publish(
                EVENTS_EXCHANGE,
                record.type,
                Buffer.from(JSON.stringify(record.payload)),
                {
                    // Survives a broker restart — together with a durable queue, which is
                    // the half of the pair people forget. One without the other persists
                    // nothing.
                    persistent: true,
                    mandatory: true,
                    messageId: record.id,
                    type: record.type,
                    contentType: 'application/json',
                    timestamp: Math.floor(Date.now() / 1000),
                    appId: APP_ID,
                },
                // Called once the broker has answered for *this* message: basic.ack, or an
                // error on basic.nack. An unroutable message is confirmed rather than
                // nacked, which is why the return check below is a separate question.
                (error: unknown) => {
                    if (error === null || error === undefined) {
                        resolve();
                    } else {
                        reject(error instanceof Error ? error : new Error(String(error)));
                    }
                },
            );
        });

        if (this.returned.delete(record.id)) {
            throw new Error(
                `${record.type} was returned as unroutable: nothing is bound to ` +
                    `'${record.type}' on exchange '${EVENTS_EXCHANGE}'. The broker ` +
                    'confirmed the publish and discarded the message — declare the topology ' +
                    'before publishing.',
            );
        }

        this.tally.published += 1;
    }

    async close(): Promise<void> {
        const [channel, model] = [this.channel, this.model];
        this.channel = null;
        this.model = null;
        this.opening = null;

        await closeQuietly(channel);
        await closeQuietly(model);
    }

    /** Nest calls this on app.close(); the demos call close() themselves. */
    onModuleDestroy(): Promise<void> {
        return this.close();
    }

    private ready(): Promise<ConfirmChannel> {
        if (this.channel !== null) {
            return Promise.resolve(this.channel);
        }

        // Two checkouts finishing at once must not open two connections, and the second
        // must not start before the first has failed either.
        this.opening ??= this.open().finally(() => {
            this.opening = null;
        });

        return this.opening;
    }

    private async open(): Promise<ConfirmChannel> {
        const model = await connectBroker(this.url);
        const channel = (await model.createConfirmChannel()) as ConfirmChannel;
        silenceChannelErrors(channel);

        channel.on('return', (message) => {
            const id = message.properties.messageId;

            if (typeof id === 'string') {
                this.returned.add(id);
            }
        });

        // A dropped connection must not leave a closed channel cached: the next publish
        // has to open a new one rather than write into a socket that is gone.
        const forget = (): void => {
            this.channel = null;
            this.model = null;
        };
        channel.on('close', forget);
        model.on('close', forget);
        model.on('error', forget);

        this.model = model;
        this.channel = channel;

        return channel;
    }
}
