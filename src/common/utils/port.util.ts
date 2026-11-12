import { connect } from 'node:net';

/**
 * Whether anything is listening, asked with a **raw socket**.
 *
 * Not `fetch`. Node's global fetch keeps a connection pool keyed on (host, port), so
 * after a server on that port has been stopped and started it can hand out a dead socket
 * from the pool and the request hangs until a timeout — which reads as "the server is
 * slow" rather than "this is the wrong question". A TCP connect asks the operating system
 * instead, and the operating system is not caching anything.
 */
export function isPortAlive(port: number, host = '127.0.0.1', timeoutMs = 500): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = connect({ port, host });
        const settle = (alive: boolean): void => {
            socket.destroy();
            resolve(alive);
        };

        socket.setTimeout(timeoutMs);
        socket.once('connect', () => settle(true));
        socket.once('error', () => settle(false));
        socket.once('timeout', () => settle(false));
    });
}
