import type { Request } from 'express';
import { Counter, collectDefaultMetrics, Histogram, Registry } from 'prom-client';
import {
    DURATION_BUCKETS,
    HTTP_REQUEST_DURATION,
    HTTP_REQUESTS_TOTAL,
    METRIC_LABELS,
    UNMATCHED_ROUTE,
} from '../constants/observability.constant';

/**
 * RED, in two instruments.
 *
 * **Rate** and **Errors** come out of one counter — a rate is the counter differentiated
 * and an error rate is the same counter with a status filter, so two metrics for them
 * would be two things to keep in step. **Duration** is a Histogram and deliberately not a
 * Summary: a Summary computes its quantiles inside the process, and quantiles cannot be
 * averaged, so the moment there are two replicas the p95 on the dashboard is not the p95
 * of anything. A histogram ships bucket counters, which add up.
 */

/** Its own registry rather than the global default, so a test can hold one of its own. */
export const metricsRegistry = new Registry();

// Event loop lag, heap, open handles, GC: the USE questions about this process. They are
// free here and they are the first thing anybody asks when p95 moves and nothing else did.
collectDefaultMetrics({ register: metricsRegistry });

export const httpRequestsTotal = new Counter({
    name: HTTP_REQUESTS_TOTAL,
    help: 'HTTP requests handled, by method, route template and response status.',
    labelNames: METRIC_LABELS,
    registers: [metricsRegistry],
});

export const httpRequestDuration = new Histogram({
    name: HTTP_REQUEST_DURATION,
    help: 'HTTP request duration in seconds, by method, route template and status.',
    labelNames: METRIC_LABELS,
    buckets: DURATION_BUCKETS,
    registers: [metricsRegistry],
});

/**
 * The label that decides whether this metric costs one series or one per customer.
 *
 * Three sources, in order, and the order is the point:
 *
 * 1. Express's own route template once a handler matched — `/orders/:orderId`. It also
 *    covers the operational routes that are deliberately not in the contract.
 * 2. The contract's template for a request the validator refused **before** routing. A
 *    400 on a malformed body is a real request and belongs on the panel; without this it
 *    would land in the bucket below and every validation failure would look alike.
 *    Rewritten from `{orderId}` to `:orderId` so one label has one shape.
 * 3. `<unmatched>` — one series for everything that matched nothing, which is exactly
 *    what a label for "a path nobody serves" must be: a scan for open endpoints would
 *    otherwise write one time series per guess.
 */
export function routeTemplateOf(request: Request): string {
    const expressRoute = (request as Request & { route?: { path?: string } }).route?.path;

    if (typeof expressRoute === 'string' && expressRoute.length > 0) {
        return `${request.baseUrl ?? ''}${expressRoute}`;
    }

    const openApiRoute = (request as Request & { openapi?: { openApiRoute?: string } }).openapi
        ?.openApiRoute;

    if (typeof openApiRoute === 'string' && openApiRoute.length > 0) {
        return openApiRoute.replace(/\{([^}]+)\}/g, ':$1');
    }

    return UNMATCHED_ROUTE;
}
