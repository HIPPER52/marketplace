import { randomUUID } from 'node:crypto';
import { emit, fail } from '../scripts/lib/emit.mjs';
import { delay } from '../scripts/lib/shell.mjs';
import { clearRateLimits } from './lib/clean.mjs';
import { samplesOf, scrape, seriesOf, sumOf } from './lib/exposition.mjs';
import { startApp } from './lib/harness.mjs';

/**
 * RED counts what happened, and a label's value set stays bounded.
 *
 *   npm run demo:metrics
 *
 * Two measurements in one run, because they are two halves of the same decision.
 *
 * **What happened.** Sixty requests are sent, some of which fail on purpose, and the
 * counter is read before and after. The delta has to equal the number sent and the error
 * delta the number that failed — which is only true if the instrumentation sits in front
 * of everything, including the requests the contract validator refuses before a
 * controller ever sees them.
 *
 * **What it costs.** A hundred requests with a hundred different order ids go through a
 * route whose label is a **template**, and the number of time series does not move. Put
 * the raw path in that label and it would move by a hundred — each one a separate series
 * with its own memory, kept for as long as the retention says, for ever.
 *
 * And one number that is neither: `above-top-bucket`. `histogram_quantile` cannot see
 * past the last finite boundary, so anything above it makes the panel report the boundary
 * itself and look healthy at exactly the wrong moment. If this is not zero the answer is
 * more buckets, never a faster demo.
 */

const OK_REQUESTS = 40;
const FAILING_REQUESTS = 20;
const CARDINALITY_REQUESTS = 100;
const REQUEST_FLOOR = 50;

const BUYER_EMAIL = 'buyer@marketplace.local';
const BUYER_PASSWORD = 'demo-password';

const OK_ROUTE = '/products';
const FAILING_ROUTE = '/demo/fail';
const COUNTER = 'http_requests_total';
const DURATION_COUNT = 'http_request_duration_seconds_count';
const DURATION_BUCKET = 'http_request_duration_seconds_bucket';

function is5xx(status) {
    return status >= 500;
}

/** The largest finite `le` the histogram declares, read out of the exposition itself. */
function topBucketOf(samples, route) {
    const edges = samplesOf(samples, DURATION_BUCKET, { route })
        .map((sample) => Number(sample.labels.le))
        .filter((edge) => Number.isFinite(edge));

    return Math.max(...edges);
}

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

async function main() {
    // Every run starts from the same place — see lib/clean.mjs.
    await clearRateLimits();

    const app = await startApp();

    try {
        /**
         * Signed in here rather than where the token is first used, and the reason is the
         * measurement below.
         *
         * `POST /auth/login` is a request like any other, so it creates its own label set
         * — and a login taken between `series-before` and `series-after` adds exactly one
         * series, which is then reported as cardinality growth caused by a hundred ids.
         * Measured: it did, and the number was 1.
         *
         * The token itself matters later. #23's sliding window allows 120 requests a
         * minute per caller, and the caller is the token's subject when there is a token
         * and the address when there is not. The sixty requests below spend the address's
         * allowance; a hundred more on the same one would start coming back 429 — a
         * correct answer, a new label set and therefore a new series, so the number would
         * move for a reason that has nothing to do with the route label.
         */
        const token = await login(app);

        // Warm every label set this run will use. `series-before` has to be taken with
        // the series already in existence, or the first request of the measured phase
        // would create one and the count would move for a reason that is not the point.
        await fetch(`${app.baseUrl}${OK_ROUTE}?limit=1`);
        await fetch(`${app.baseUrl}${FAILING_ROUTE}`);
        await fetch(`${app.baseUrl}/products/${randomUUID()}`, {
            headers: { authorization: `Bearer ${token}` },
        });
        await delay(200);

        const before = await scrape(app.baseUrl);
        const totalBefore = sumOf(before, COUNTER);
        const fiveHundredsBefore = sumOf(before, COUNTER, { status: '500' });

        let sentOk = 0;
        let sentFail = 0;

        const responses = await Promise.all([
            ...Array.from({ length: OK_REQUESTS }, () =>
                fetch(`${app.baseUrl}${OK_ROUTE}?limit=1`),
            ),
            ...Array.from({ length: FAILING_REQUESTS }, () =>
                fetch(`${app.baseUrl}${FAILING_ROUTE}`),
            ),
        ]);

        for (const response of responses) {
            if (is5xx(response.status)) {
                sentFail += 1;
            } else {
                sentOk += 1;
            }
        }

        // The counter moves when the response finishes, which is a tick after the client
        // has it.
        await delay(400);

        const after = await scrape(app.baseUrl);
        const counterDelta = sumOf(after, COUNTER) - totalBefore;
        const errorsDelta = sumOf(after, COUNTER, { status: '500' }) - fiveHundredsBefore;

        const topBucket = topBucketOf(after, OK_ROUTE);
        const aboveTopBucket =
            sumOf(after, DURATION_COUNT, { route: OK_ROUTE }) -
            sumOf(after, DURATION_BUCKET, { route: OK_ROUTE, le: String(topBucket) });

        // --- the cardinality half ------------------------------------------------------
        const seriesBefore = seriesOf(after, COUNTER);

        await Promise.all(
            Array.from({ length: CARDINALITY_REQUESTS }, () =>
                fetch(`${app.baseUrl}/products/${randomUUID()}`, {
                    headers: { authorization: `Bearer ${token}` },
                }),
            ),
        );

        await delay(400);

        const seriesAfter = seriesOf(await scrape(app.baseUrl), COUNTER);

        emit('sent-ok', sentOk);
        emit('sent-fail', sentFail);
        emit('counter-delta', counterDelta);
        emit('errors-delta', errorsDelta);
        emit('top-bucket-seconds', topBucket);
        emit('above-top-bucket', aboveTopBucket);
        emit('series-before', seriesBefore);
        emit('series-after', seriesAfter);
        emit('distinct-ids-sent', CARDINALITY_REQUESTS);

        if (sentOk + sentFail < REQUEST_FLOOR) {
            fail(`${sentOk + sentFail} requests is below the floor of ${REQUEST_FLOOR}.`);
        }

        if (counterDelta !== sentOk + sentFail) {
            fail(
                `the counter moved by ${counterDelta} for ${sentOk + sentFail} requests: ` +
                    'something was not instrumented.',
            );
        }

        if (errorsDelta !== sentFail) {
            fail(
                `${sentFail} requests failed and the 5xx counter moved by ${errorsDelta}: ` +
                    'the status label is not the HTTP status.',
            );
        }

        if (aboveTopBucket !== 0) {
            fail(
                `${aboveTopBucket} observations are above the top finite bucket (${topBucket} s): ` +
                    'the quantile will stop at that boundary and look healthy. Add buckets.',
            );
        }

        if (seriesAfter !== seriesBefore) {
            fail(
                `${CARDINALITY_REQUESTS} ids added ${seriesAfter - seriesBefore} time series: ` +
                    'the route label is carrying a value the caller chooses.',
            );
        }
    } finally {
        await app.stop();
    }
}

main().catch((error) => {
    console.error(`\ndemo:metrics failed: ${error.message}\n`);
    process.exitCode = 2;
});
