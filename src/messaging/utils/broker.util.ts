import amqp, { type Channel, type ChannelModel } from 'amqplib';

/**
 * One connection, opened the same way everywhere.
 *
 * `heartbeat` is the reason this is a function rather than a call site. amqplib's default
 * is whatever the server proposes, and a consumer that is quiet for a while behind a NAT
 * loses its connection without either side noticing until the next publish. Ten seconds
 * is short enough that a dead peer is found while the demo is still running.
 */
export function connectBroker(url: string): Promise<ChannelModel> {
    return amqp.connect(url, { clientProperties: { connection_name: 'marketplace' } });
}

/**
 * Close something that may already be broken.
 *
 * A channel that took a channel-level error — a 406 on a queue argument, a 404 on a
 * missing exchange — is closed by the broker before `close()` is called, and calling it
 * then rejects. That rejection is never the interesting error: the one worth reporting
 * happened a moment earlier, and letting the cleanup throw over it loses it.
 */
export async function closeQuietly(target: { close(): Promise<void> } | null): Promise<void> {
    if (target === null) {
        return;
    }

    try {
        await target.close();
    } catch {
        // Already gone. Nothing left to close, and nothing worth saying about it.
    }
}

/**
 * amqplib channels are EventEmitters, and an 'error' event with no listener is rethrown
 * by Node as an uncaught exception — which turns a rejected promise that the caller is
 * about to handle into a dead process. Every channel this project opens gets one.
 */
export function silenceChannelErrors(channel: Channel): Channel {
    channel.on('error', () => {
        // The operation that caused it rejects on its own; that rejection is the report.
    });

    return channel;
}
