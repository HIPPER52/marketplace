import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * What is true about the request being served, available to code that was never handed
 * the request.
 *
 * This is the whole of correlation, and it is a **discipline about context** rather than
 * a feature of a logger. The alternative is `req` as a parameter on every function that
 * might one day want to log — through the service, through the repository, into the
 * mapper — and the moment one layer does not take it, its lines come out without an
 * identifier and the incident has a hole in the middle of it.
 *
 * The correlator itself is deliberately **not** here: `trace_id` comes from the active
 * OpenTelemetry span, so the id in a log line is the id of a span that exists in the
 * trace backend and the id that arrived in the `traceparent` header. A home-grown uuid
 * would look identical in the log and match nothing anywhere else.
 */
export interface RequestContext {
    /** The subject of a verified token, filled in once authentication has run. */
    userId?: string;
    /** Carried for the day this serves more than one; from a header, never from a body. */
    tenant?: string;
    /** #22's key, so a replay can be followed through the log by the key it replayed. */
    idempotencyKey?: string;
    /** The route template, as soon as Express knows it. */
    route?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runInRequestContext<T>(context: RequestContext, run: () => T): T {
    return storage.run(context, run);
}

export function currentRequestContext(): RequestContext | undefined {
    return storage.getStore();
}

/**
 * Adds to the context of the request in flight. The store is one mutable object, so a
 * guard that learns who the caller is can say so and every later line carries it —
 * including lines written by code that ran before the guard did, since they share the
 * object rather than a copy.
 */
export function amendRequestContext(patch: RequestContext): void {
    const current = storage.getStore();

    if (current !== undefined) {
        Object.assign(current, patch);
    }
}
