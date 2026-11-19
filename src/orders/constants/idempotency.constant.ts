/**
 * The two header names #22's key travels in.
 *
 * Both are declared in `openapi/openapi.yaml`, which is why they are named here rather
 * than typed into a decorator: a header name is a domain concept the contract owns, and a
 * literal in one of three places is the typo nothing catches. The request header is
 * lower-case because that is what Node hands back — see the README's gotcha about the
 * validator's own error details saying `'idempotency-key'`.
 */
export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';

/** Set on a replayed 201, so a client can tell "created" from "created earlier". */
export const IDEMPOTENCY_REPLAY_HEADER = 'Idempotency-Replay';
