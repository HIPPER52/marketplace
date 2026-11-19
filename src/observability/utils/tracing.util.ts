import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { ExpressLayerType } from '@opentelemetry/instrumentation-express';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchSpanProcessor, type SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { SERVICE_NAME } from '../constants/observability.constant';

/**
 * OpenTelemetry, started **before anything else in this process is loaded**.
 *
 * That order is the requirement and not a preference. Auto-instrumentation works by
 * intercepting `require`, so a module that is already in the cache is a module nobody
 * patched: start the SDK after `express` has been imported and the HTTP spans quietly do
 * not appear, with no error anywhere to say why. `main.ts` therefore imports this file
 * first and reaches everything else — Nest, the validator, the application module —
 * through dynamic imports that happen afterwards.
 *
 * A provider assembled by hand rather than `NodeSDK`, for one concrete reason:
 * `forceFlush` is on the provider and is what `demo:trace` needs. A batch exporter sends
 * on a timer, so without a flush the demo asks the backend for a trace the process is
 * still holding and concludes, wrongly, that nothing was recorded.
 */

/**
 * Half a second rather than the five the SDK defaults to.
 *
 * Nothing here needs batching for throughput — this is a demonstration stand — and a
 * five-second delay turns every "ask the backend" into a five-second wait or a flake.
 */
const EXPORT_DELAY_MS = 500;

let provider: NodeTracerProvider | undefined;

/**
 * Where spans go, and what it means when nobody says.
 *
 * Unset is a supported configuration rather than an error: spans are still created, the
 * context still propagates and `trace_id` still reaches every log line — there is simply
 * no backend to look them up in. `demo:logs` needs exactly that and runs without the
 * stand; `demo:trace` needs the backend and says so.
 */
function exporterFor(endpoint: string | undefined): SpanProcessor[] {
    if (endpoint === undefined || endpoint.trim() === '') {
        return [];
    }

    return [
        new BatchSpanProcessor(
            // The OTLP/HTTP convention: the base endpoint plus the signal's path.
            new OTLPTraceExporter({ url: `${endpoint.replace(/\/$/, '')}/v1/traces` }),
            { scheduledDelayMillis: EXPORT_DELAY_MS },
        ),
    ];
}

export function startTracing(): void {
    if (provider !== undefined) {
        return;
    }

    provider = new NodeTracerProvider({
        resource: resourceFromAttributes({
            [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? SERVICE_NAME,
            [ATTR_SERVICE_VERSION]: process.env.npm_package_version ?? '0.0.0',
        }),
        spanProcessors: exporterFor(process.env.OTEL_EXPORTER_OTLP_ENDPOINT),
    });

    provider.register();

    registerInstrumentations({
        instrumentations: [
            getNodeAutoInstrumentations({
                // Every file read is not a unit of work anybody debugs, and it is the
                // single noisiest instrumentation there is.
                '@opentelemetry/instrumentation-fs': { enabled: false },
                '@opentelemetry/instrumentation-dns': { enabled: false },
                // The scrape is not traffic: it would put a span on every scrape interval
                // for ever and tell nobody anything.
                '@opentelemetry/instrumentation-http': {
                    ignoreIncomingRequestHook: (request) =>
                        (request.url ?? '').startsWith('/metrics'),
                },
                // One request through this service produced **thirty-four** spans, and
                // twenty-four of them were Express middleware: the body parser, each of
                // the validator's internal layers, the patched router. They are not units
                // of work anybody debugs, and a trace nobody can read is a trace nobody
                // opens. The handler span and the controller span stay.
                '@opentelemetry/instrumentation-express': {
                    ignoreLayersType: [ExpressLayerType.MIDDLEWARE],
                },
                // Off, deliberately: it injects `trace_id`, `span_id` and `trace_flags`
                // into every pino line by patching the logger — which is the same job the
                // mixin in logger.util.ts does, in source anybody here can read. Two
                // mechanisms writing one field is one too many, and the mixin is the one
                // this project can explain.
                '@opentelemetry/instrumentation-pino': { enabled: false },
            }),
        ],
    });
}

/** Sends what is buffered and waits for it. Used by the demos, never by a request path. */
export async function flushTracing(): Promise<void> {
    await provider?.forceFlush();
}

export async function stopTracing(): Promise<void> {
    await provider?.shutdown();
    provider = undefined;
}
