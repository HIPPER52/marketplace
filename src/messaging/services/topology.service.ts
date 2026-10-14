import type { ChannelModel } from 'amqplib';
import {
    DEAD_LETTER_EXCHANGE,
    DELIVERY_LIMIT,
    EVENTS_EXCHANGE,
    ORDER_PLACED_DLQ,
    ORDER_PLACED_KEY,
    ORDER_PLACED_QUEUE,
} from '../constants/topology.constant';
import { closeQuietly, silenceChannelErrors } from '../utils/broker.util';

/**
 * Exchange, queue, binding, dead-letter contour — declared by the side that reads, never
 * by the side that writes.
 *
 * The producer must not know who is listening. That is not tidiness: the moment checkout
 * declares the queue it publishes into, adding a second consumer means editing checkout,
 * and the thing a broker was introduced to remove — the producer's knowledge of its
 * readers — is back with extra steps. So this runs from the consumer, or from the
 * bootstrap step the demos begin with, and the publisher only ever names an exchange and
 * a routing key.
 *
 * The order is load-bearing: exchange, then dead-letter queue, then the work queue that
 * points at it, then the binding. A message published before the binding exists is routed
 * nowhere, and the broker answers the publisher with a positive confirm while discarding
 * it — the quietest failure in the lecture. The publisher sets `mandatory` for the same
 * reason; see OrderEventPublisher.
 */
export async function declareTopology(model: ChannelModel): Promise<void> {
    const channel = silenceChannelErrors(await model.createChannel());

    try {
        await channel.assertExchange(EVENTS_EXCHANGE, 'topic', { durable: true });
        await channel.assertExchange(DEAD_LETTER_EXCHANGE, 'topic', { durable: true });

        // The dead-letter queue first, so the target exists before anything can be sent
        // to it. Dead-lettering republishes without publisher confirms and removes the
        // message from the original queue immediately, so a missing target queue is a
        // lost message — rabbitmq.com/docs/dlx says so in as many words.
        await channel.assertQueue(ORDER_PLACED_DLQ, {
            durable: true,
            arguments: { 'x-queue-type': 'quorum' },
        });

        // '#' rather than the original key: whatever dies, this queue is where it lands.
        // Dead-lettering preserves the routing key the message was published with, which
        // is information worth keeping — a binding that discarded it would be a contour
        // that cannot tell one kind of failure from another.
        await channel.bindQueue(ORDER_PLACED_DLQ, DEAD_LETTER_EXCHANGE, '#');

        await channel.assertQueue(ORDER_PLACED_QUEUE, {
            durable: true,
            arguments: {
                // Quorum, not classic: classic queues stopped replicating in 4.0 and
                // x-delivery-limit — the thing that bounds a poison message — is a quorum
                // feature. Mirrored queues (ha-mode) are not an alternative; they were
                // removed in the same release.
                'x-queue-type': 'quorum',
                'x-dead-letter-exchange': DEAD_LETTER_EXCHANGE,
                'x-delivery-limit': DELIVERY_LIMIT,
            },
        });

        await channel.bindQueue(ORDER_PLACED_QUEUE, EVENTS_EXCHANGE, ORDER_PLACED_KEY);
    } catch (error: unknown) {
        throw describeDeclarationFailure(error);
    } finally {
        await closeQuietly(channel);
    }
}

/**
 * A queue's x-arguments are immutable. Changing DELIVERY_LIMIT or pointing the queue at a
 * different dead-letter exchange and re-running is answered with 406 PRECONDITION_FAILED
 * — not a client bug, and not something a retry fixes. The message below is the thing
 * that is actually hard to find out.
 */
function describeDeclarationFailure(error: unknown): Error {
    const code = (error as { code?: number } | null)?.code;

    if (code !== 406) {
        return error instanceof Error ? error : new Error(String(error));
    }

    return new Error(
        [
            `The broker refused the topology: ${(error as Error).message}`,
            '',
            'A queue that already exists cannot have its arguments changed — 406',
            'PRECONDITION_FAILED is RabbitMQ saying so. The queue here was declared by an',
            'earlier run with different settings. Either delete it:',
            '',
            `    docker compose exec rabbitmq rabbitmqctl delete_queue ${ORDER_PLACED_QUEUE}`,
            `    docker compose exec rabbitmq rabbitmqctl delete_queue ${ORDER_PLACED_DLQ}`,
            '',
            'or hang the setting off a policy instead, which can be rewritten in place.',
        ].join('\n'),
    );
}
