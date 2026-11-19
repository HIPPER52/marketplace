import type { NextFunction, Request, Response } from 'express';
import { IDEMPOTENCY_KEY_HEADER } from '../../orders/constants/idempotency.constant';
import { METRICS_PATH } from '../constants/observability.constant';
import { loggerFor } from '../utils/logger.util';
import { routeTemplateOf } from '../utils/metrics.util';
import { amendRequestContext, runInRequestContext } from '../utils/request-context.util';

const log = loggerFor('http.access');

/**
 * Opens the context the whole request runs inside, and writes the one line that says it
 * happened.
 *
 * **Plain Express middleware, registered before the validator**, rather than a Nest
 * middleware. A request the OpenAPI validator refuses never reaches Nest at all, and a
 * 400 that appears in no log and on no panel is the most expensive kind of silence: the
 * client says "your API is broken" and the service has no record of being asked.
 *
 * The listener is attached **inside** `runInRequestContext`, which is why it still sees
 * the context when it fires. That is the whole of AsyncLocalStorage's one sharp edge: a
 * callback created outside the context — a pool handler, a listener installed at startup,
 * a queue worker — runs without it and logs a line with no correlator at all. Where that
 * is unavoidable the cure is `AsyncResource.bind`, and it is a cure for a boundary rather
 * than for a bug.
 */
export function requestContextMiddleware(
    request: Request,
    response: Response,
    next: NextFunction,
): void {
    // A scrape is not traffic here either. Prometheus asks every five seconds for ever,
    // and a log line per scrape is a bill with no information in it.
    if (request.path === METRICS_PATH) {
        next();
        return;
    }

    const startedAt = process.hrtime.bigint();
    const idempotencyKey = request.header(IDEMPOTENCY_KEY_HEADER) ?? undefined;

    runInRequestContext({ idempotencyKey }, () => {
        response.on('finish', () => {
            const route = routeTemplateOf(request);
            amendRequestContext({ route });

            const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
            const line = {
                req: {
                    method: request.method,
                    url: request.originalUrl,
                    // Logged in full and redacted by path: `authorization` is the one
                    // secret this service does put in front of its own logger, and
                    // `demo:logs` sends a marker inside it to prove the redaction holds.
                    headers: request.headers,
                },
                res: { statusCode: response.statusCode },
                route,
                duration_ms: Number(durationMs.toFixed(3)),
            };

            // A body is never logged, anywhere. It is the most useful thing in an incident
            // and the most dangerous thing in a log, and this service resolves that by not
            // having the argument: passwords, tokens and card numbers all arrive in bodies.
            if (response.statusCode >= 500) {
                log.error(line, 'request failed');
            } else {
                log.info(line, 'request completed');
            }
        });

        next();
    });
}
