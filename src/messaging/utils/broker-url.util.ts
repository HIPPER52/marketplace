const AMQP_PROTOCOLS = ['amqp:', 'amqps:'] as const;

/**
 * Ports that answer, but not with AMQP.
 *
 * 15672 is RabbitMQ's management HTTP API and 25673 is where docker-compose.yml publishes
 * it on this stand. A client pointed at either does not get a protocol error — it gets a
 * connection that hangs and then dies, which reads as "the broker is down". Named because
 * the numbers mean something; the duplication with docker-compose.yml cannot be removed
 * (compose cannot import TypeScript), only labelled.
 */
const MANAGEMENT_PORTS = ['15672', '25673'] as const;

/**
 * What is wrong with a broker URL, or null when nothing is.
 *
 * The same shape as databaseUrlProblem, and checked in both places that read the variable
 * — the service's environment schema and the demos' — so the two cannot disagree about
 * what a usable value looks like.
 *
 * The port is the trap worth catching early. 15672 is the management HTTP API; a client
 * pointed at it does not get a protocol error, it gets a connection that hangs and then
 * dies, and the symptom reads as "the broker is down".
 */
export function brokerUrlProblem(raw: string): string | null {
    let url: URL;

    try {
        url = new URL(raw);
    } catch {
        return 'must be a URL, e.g. amqp://marketplace_app:local_dev_password@localhost:25672';
    }

    if (!AMQP_PROTOCOLS.includes(url.protocol as (typeof AMQP_PROTOCOLS)[number])) {
        return `must use one of ${AMQP_PROTOCOLS.join(' / ')}, got ${url.protocol}`;
    }

    if (url.username === '') {
        return (
            'must name the broker user: RabbitMQ allows the default `guest` from loopback ' +
            'only, and a connection through a published port does not qualify'
        );
    }

    if (MANAGEMENT_PORTS.includes(url.port as (typeof MANAGEMENT_PORTS)[number])) {
        return `port ${url.port} is the management UI and does not speak AMQP — 25672 does`;
    }

    return null;
}
