import { emit, fail } from '../scripts/lib/emit.mjs';
import { delay } from '../scripts/lib/shell.mjs';
import { clearRateLimits } from './lib/clean.mjs';
import { newTraceparent, startApp } from './lib/harness.mjs';

/**
 * The correlator lives in the context, not in the arguments.
 *
 *   npm run demo:logs
 *
 * Three things are proved, and the second is the one people get wrong:
 *
 * 1. one request writes lines from **three different layers** and every one of them
 *    carries the same `trace_id` — which no function was handed, because the id comes
 *    from the active span through a pino mixin and the rest comes from AsyncLocalStorage;
 * 2. **eight requests in flight at once do not mix**. The classic failure is a "current
 *    request" in a module-level variable: it works perfectly for one caller and silently
 *    interleaves for two, so the group sizes come out uneven and the lines of one request
 *    end up filed under another's id;
 * 3. a bearer token and a password sent on the same request appear nowhere in the log,
 *    while the request itself does.
 *
 * It needs no stand. Spans are created whether or not there is a backend to export them
 * to, so the correlator exists either way — `demo:trace` is the one that needs Jaeger.
 */

const BURST = 8;
const LAYER_FLOOR = 3;

/** Two strings that exist only so that a search for them can come back empty. */
const TOKEN_MARKER = 'tok-marker-6f2b9c1d4e';
const PASSWORD_MARKER = 'pwd-marker-a81e37c5b0';

const BUYER_EMAIL = 'buyer@marketplace.local';
const BUYER_PASSWORD = 'demo-password';

async function login(app) {
    const response = await fetch(`${app.baseUrl}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: BUYER_EMAIL, password: BUYER_PASSWORD }),
    });

    if (!response.ok) {
        throw new Error(`could not sign in as ${BUYER_EMAIL}: ${response.status}`);
    }

    return (await response.json()).access_token;
}

function groupByTrace(records) {
    const groups = new Map();

    for (const record of records) {
        if (typeof record.trace_id !== 'string') {
            continue;
        }

        groups.set(record.trace_id, (groups.get(record.trace_id) ?? 0) + 1);
    }

    return groups;
}

async function main() {
    // Every run starts from the same place — see lib/clean.mjs.
    await clearRateLimits();

    // debug, so the repository's own line is written: the point is that a layer which
    // never sees the request still logs with the request's id, and the repository is the
    // deepest one there is here.
    const app = await startApp({ LOG_LEVEL: 'debug' });

    try {
        const token = await login(app);

        // --- one request, three layers, one id --------------------------------------
        const single = newTraceparent();
        const singleMark = app.mark();

        await fetch(`${app.baseUrl}/orders?limit=1`, {
            headers: { authorization: `Bearer ${token}`, traceparent: single.header },
        });

        await app.waitForRequest(single.traceId);

        const singleRecords = app
            .recordsSince(singleMark)
            .filter((record) => record.trace_id === single.traceId);

        const layers = new Set(singleRecords.map((record) => record.layer)).size;
        const ids = new Set(
            app
                .recordsSince(singleMark)
                .filter((record) => record.layer?.startsWith('orders.'))
                .map((record) => record.trace_id),
        );

        // --- eight at once, which is where a module-level "current request" dies ------
        const burstMark = app.mark();
        const burst = Array.from({ length: BURST }, () => newTraceparent());

        await Promise.all(
            burst.map((parent) =>
                fetch(`${app.baseUrl}/orders?limit=1`, {
                    headers: { authorization: `Bearer ${token}`, traceparent: parent.header },
                }),
            ),
        );

        await Promise.all(burst.map((parent) => app.waitForRequest(parent.traceId)));

        const groups = groupByTrace(app.recordsSince(burstMark));
        const sizes = [...groups.values()];
        const uneven = sizes.filter((size) => size !== sizes[0]).length;

        // --- a token and a password on one request -----------------------------------
        const secretMark = app.mark();

        await fetch(`${app.baseUrl}/auth/login`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${TOKEN_MARKER}`,
            },
            body: JSON.stringify({ email: BUYER_EMAIL, password: PASSWORD_MARKER }),
        });

        // The access line is written when the response finishes, which can be a tick
        // after the client has it.
        await delay(300);

        const secretRecords = app.recordsSince(secretMark);
        const secretRequestLogged = secretRecords.some(
            (record) => record.req?.url === '/auth/login',
        );
        const leaked = app.lines.filter(
            (line) => line.includes(TOKEN_MARKER) || line.includes(PASSWORD_MARKER),
        ).length;

        emit('non-json-lines', app.nonJsonLines);
        emit('layers', layers);
        emit('distinct-trace-ids', ids.size);
        emit('trace-id-matches-header', singleRecords.length > 0 ? 1 : 0);
        emit('burst', BURST);
        emit('burst-trace-ids', groups.size);
        emit('burst-uneven', uneven);
        emit('secret-req-logged', secretRequestLogged ? 1 : 0);
        emit('secret-in-logs', leaked);

        if (app.nonJsonLines > 0) {
            fail(`${app.nonJsonLines} lines of stdout were not JSON: the log cannot be queried.`);
        }

        if (layers < LAYER_FLOOR) {
            fail(`one request wrote from ${layers} layers, not ${LAYER_FLOOR}.`);
        }

        if (ids.size !== 1) {
            fail(`one request produced ${ids.size} distinct trace ids inside the service.`);
        }

        if (singleRecords.length === 0) {
            fail('no line carried the trace id from the traceparent header.');
        }

        if (groups.size !== BURST || uneven !== 0) {
            fail(
                `${BURST} concurrent requests produced ${groups.size} groups of sizes ` +
                    `${sizes.join(', ')}: the context is leaking between requests.`,
            );
        }

        if (!secretRequestLogged) {
            fail('the request carrying the secrets was not logged at all.');
        }

        if (leaked > 0) {
            fail(`${leaked} log lines contain a marker that was sent as a secret.`);
        }
    } finally {
        await app.stop();
    }
}

main().catch((error) => {
    console.error(`\ndemo:logs failed: ${error.message}\n`);
    process.exitCode = 2;
});
