/**
 * The room one order's watchers share, and the event they are watching for.
 *
 * Both are protocol: a client that joins the wrong string hears nothing, and no error
 * says why. They are named here so the gateway, the demo script and the README cannot
 * drift from one another.
 */
export function roomOf(orderId: string): string {
    return `orders:${orderId}`;
}

export const ORDER_STATUS_EVENT = 'order.status';

/** The socket.io message a client sends to be let into a room. */
export const JOIN_EVENT = 'join';
