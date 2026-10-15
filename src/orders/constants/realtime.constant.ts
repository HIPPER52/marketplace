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

/**
 * Who is asking, over HTTP. The WebSocket gateway takes the same claim from its
 * handshake; this is the SSE half of one rule — an order's events belong to its buyer.
 * Declared in openapi.yaml, so a request without it is refused by the validator rather
 * than by an `if`.
 */
export const USER_ID_HEADER = 'x-user-id';

/**
 * Why a `join` was refused.
 *
 * The client branches on these, so they are part of the realtime contract in the same way
 * a status code is part of the HTTP one — and an inline literal in a gateway is a contract
 * term nobody can find by searching for its name.
 */
export const JoinRefusal = {
    /** No usable identity was claimed, or claims are not accepted here at all. */
    Unauthenticated: 'unauthenticated',
    /** The frame did not carry `{ orderId }`. */
    BadRequest: 'bad-request',
    NotFound: 'not-found',
    /** The order exists and belongs to somebody else. */
    Forbidden: 'forbidden',
} as const;

export type JoinRefusal = (typeof JoinRefusal)[keyof typeof JoinRefusal];
