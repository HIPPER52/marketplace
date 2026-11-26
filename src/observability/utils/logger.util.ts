import { trace } from '@opentelemetry/api';
import pino, { type Logger } from 'pino';
import { SERVICE_NAME } from '../constants/observability.constant';
import { REDACT_CENSOR, REDACT_PATHS } from '../constants/redact.constant';
import { currentRequestContext } from './request-context.util';

/**
 * One pino instance for the process, and every line that leaves it is JSON.
 *
 * "Every line" is not a figure of speech: Nest writes its own startup banner and TypeORM
 * writes its own query errors, and both are plain text with colours in them. Each has an
 * adapter in this folder pointing at this logger, because `demo:logs` counts
 * `non-json-lines` over the whole of stdout and a single pretty line is the difference
 * between a log you can query and a log you can grep.
 *
 * To stdout, never to a file: a container's log is its stdout, and a process that writes
 * to a path inside itself has written its log into something that is deleted when the pod
 * is evicted to another node.
 */

/**
 * Nest's levels and pino's are different vocabularies that share three words.
 *
 * `LOG_LEVEL=log` is this project's own setting since #11 and means "normal"; pino has no
 * `log` and would refuse to start. The same mismatch already cost an afternoon when pact's
 * pino logger met it — see the README's gotcha — so the translation lives here, once.
 */
const PINO_LEVEL_OF: Record<string, pino.Level> = {
    error: 'error',
    warn: 'warn',
    log: 'info',
    debug: 'debug',
    verbose: 'trace',
};

function levelFrom(raw: string | undefined): pino.Level {
    return PINO_LEVEL_OF[raw ?? 'log'] ?? 'info';
}

export const rootLogger: Logger = pino({
    level: levelFrom(process.env.LOG_LEVEL),
    base: { service: SERVICE_NAME, pid: process.pid },

    // `"level":"info"` rather than `"level":30`. The number is pino's own ordering and
    // means nothing to the person reading the line or to the demo parsing it.
    formatters: {
        level: (label) => ({ level: label }),
    },

    redact: { paths: REDACT_PATHS, censor: REDACT_CENSOR },

    /**
     * The correlator, added to every line without anybody passing anything.
     *
     * `trace.getActiveSpan()` reads OpenTelemetry's own context, which the HTTP
     * instrumentation established when the request arrived — and which it took from the
     * incoming `traceparent` header if there was one. That is what makes one key open
     * three doors: the log line, the span in the trace backend, and the header the caller
     * sent. A uuid generated here would be a fourth thing that matches none of them.
     */
    mixin() {
        const span = trace.getActiveSpan();
        const context = currentRequestContext();

        return {
            ...(span === undefined
                ? {}
                : {
                      trace_id: span.spanContext().traceId,
                      span_id: span.spanContext().spanId,
                  }),
            ...context,
        };
    },
});

/**
 * A logger that says which part of the service is speaking.
 *
 * One request crosses the controller, the service and the repository, and "the same
 * trace_id in three layers" is only a provable statement if each line says which layer it
 * is. `demo:logs` counts the distinct values and requires at least three.
 */
export function loggerFor(layer: string): Logger {
    return rootLogger.child({ layer });
}
