import { delay } from '../../scripts/lib/shell.mjs';

/**
 * Reading a trace back out of the backend.
 *
 * Jaeger v2 answers `/api/v3/traces/{id}` with OTLP JSON — the same shape the exporter
 * sent — so there is one format in this file rather than a translation between two. The
 * v1 API is still there under `/jaeger/api/`, and it is a different shape with different
 * field names; this is the stable one.
 */

/** Named, because the demo reports four numbers out of it. */
export class FetchedTrace {
    constructor(traceId, spans) {
        this.traceId = traceId;
        this.spans = spans;
    }

    /**
     * A span whose parent is nowhere to be found.
     *
     * The **incoming** parent is not one of those, and that is the subtlety: the request
     * carries a `traceparent` the demo made up, so the server span's parent is a span id
     * that exists in the demo and in no backend. Counting it would make a correctly
     * propagated trace look broken. A real orphan is a span pointing at a parent that
     * should be in this trace and is not — the shape you get when a process starts its
     * own trace instead of continuing the one it was handed.
     */
    orphansExcluding(callerSpanId) {
        const known = new Set(this.spans.map((span) => span.spanId));

        return this.spans.filter((span) => {
            const parent = span.parentSpanId;

            if (parent === undefined || parent === '' || parent === callerSpanId) {
                return false;
            }

            return !known.has(parent);
        }).length;
    }

    /** Whether any span in the trace was recorded as failed. OTLP: 2 is ERROR. */
    get hasErrorStatus() {
        return this.spans.some((span) => span.status?.code === 2);
    }
}

export async function fetchTrace(traceApiUrl, traceId, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        const response = await fetch(`${traceApiUrl.replace(/\/$/, '')}/api/v3/traces/${traceId}`);

        if (response.ok) {
            const spans = spansOf(await response.json());

            if (spans.length > 0) {
                return new FetchedTrace(traceId, spans);
            }
        }

        // A batch exporter has already been flushed by the caller; what is left is the
        // backend's own ingestion, which is fast and is not instantaneous.
        await delay(250);
    }

    return new FetchedTrace(traceId, []);
}

function spansOf(payload) {
    return (payload?.result?.resourceSpans ?? []).flatMap((resource) =>
        (resource.scopeSpans ?? []).flatMap((scope) => scope.spans ?? []),
    );
}
