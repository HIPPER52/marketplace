/**
 * The allowance, and the window it is counted over.
 *
 * A sliding window rather than a fixed one, and the question behind that choice is always
 * the same: **do we allow a burst?** A fixed window does, by construction — five requests
 * at 12:00:59 and five more at 12:01:00 are ten in 320 milliseconds against a limit of
 * five, because the counter resets on a wall-clock boundary rather than relative to the
 * caller. That is a property of the model, not a bug in an implementation. Here the limit
 * exists to stop one client eating the service, so a sanctioned 2x burst at every minute
 * boundary is the wrong default and the extra sorted set is worth its memory.
 *
 * A token bucket would be the choice if bursts were *wanted* — a client that was quiet for
 * a minute being allowed to spend that quiet. Nothing here wants that.
 */
export const RATE_LIMIT = 120;

export const RATE_WINDOW_MS = 60_000;

/**
 * Paths the limiter never sees.
 *
 * `/health` and `/readiness` are how an orchestrator finds out whether this process is
 * alive, and a limiter that answered 429 to a liveness probe would get the container
 * killed for being popular. `/socket.io` is a long-lived transport, not a request rate.
 */
export const RATE_LIMIT_EXEMPT = /^\/(health|readiness)$|^\/socket\.io(\/|$)/;
