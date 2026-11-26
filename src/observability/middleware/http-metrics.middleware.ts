import type { NextFunction, Request, Response } from 'express';
import { METRICS_PATH } from '../constants/observability.constant';
import { httpRequestDuration, httpRequestsTotal, routeTemplateOf } from '../utils/metrics.util';

/**
 * Counts what actually happened, for every request this process answered.
 *
 * Registered beside the context middleware and ahead of the validator, for the same
 * reason: instrumentation that only covers the paths which reached a controller reports a
 * service with no validation failures in it. "Errors" on the panel would then mean "the
 * errors we chose to look at", which is the failure criterion 4 is written to catch.
 *
 * The timer starts here and stops on `finish`, so the number includes everything the
 * client waited for — parsing, validation, the handler, serialisation — rather than the
 * part of it a handler happens to be able to see.
 */
export function httpMetricsMiddleware(
    request: Request,
    response: Response,
    next: NextFunction,
): void {
    // Scraping is not traffic. Counting it makes the rate panel a picture of Prometheus.
    if (request.path === METRICS_PATH) {
        next();
        return;
    }

    const stopTimer = httpRequestDuration.startTimer();

    response.on('finish', () => {
        const labels = {
            method: request.method,
            route: routeTemplateOf(request),
            // The HTTP status code, as a string, and nothing else. A label carrying a
            // message, an error class or a path is the cardinality mistake wearing a
            // different hat.
            status: String(response.statusCode),
        };

        httpRequestsTotal.inc(labels);
        stopTimer(labels);
    });

    next();
}
