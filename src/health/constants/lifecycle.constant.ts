/**
 * The two answers a readiness probe can be given about this process.
 *
 * Two and not three, deliberately. "Starting" would be a state nothing can observe: the
 * warm-up in `main.ts` runs **before** `listen()`, so while it lasts there is no socket to
 * ask and a probe gets a connection refusal rather than a 503. The state that matters at
 * runtime is the other one — the window between SIGTERM arriving and the socket closing,
 * during which this process is still serving requests and must stop being sent new ones.
 */
export const ServingState = {
    Serving: 'serving',
    Draining: 'draining',
} as const;

export type ServingState = (typeof ServingState)[keyof typeof ServingState];
