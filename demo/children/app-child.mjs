/**
 * The service, as a separate process, with its stdout belonging to the demo that started
 * it.
 *
 * A child and not an in-process instance, because what the three demos measure **is** the
 * stdout: `demo:logs` counts lines, parses every one of them as JSON and groups them by
 * `trace_id`. Capturing that from inside the same process would mean replacing pino's
 * destination, and then the thing measured would be a test harness rather than the log a
 * container actually writes.
 *
 * It runs from `dist/`: Nest reads constructor dependencies from `design:paramtypes`,
 * which only the TypeScript emitter writes, and `tsx` is esbuild.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist');

// Before the application, exactly as main.ts does it: auto-instrumentation patches
// modules as they are required, so a module already loaded is a module nobody patched.
const { startTracing, flushTracing } = await import(
    join(DIST, 'observability/utils/tracing.util.js')
);

startTracing();

const { openDemoApp } = await import(join(DIST, 'auth/utils/demo-app.util.js'));
const { NestPinoLogger } = await import(
    join(DIST, 'observability/services/nest-logger.service.js')
);
const { rootLogger } = await import(join(DIST, 'observability/utils/logger.util.js'));

const log = rootLogger.child({ layer: 'demo.harness' });

const app = await openDemoApp({
    logger: new NestPinoLogger(),

    /**
     * Two routes this service does not have and must not grow.
     *
     * `/demo/fail` answers 500. OpenTelemetry leaves a span `Unset` for a 4xx — a refused
     * request is the client's error, not the server's — so nothing but a server error
     * produces the ERROR status `demo:trace` checks. The marketplace has no endpoint
     * whose purpose is to fail, and adding one behind a flag would put code in `src/`
     * whose only job is to break.
     *
     * `/demo/flush` empties the span exporter's buffer. A batch exporter sends on a timer,
     * so without it the demo asks the backend for a trace the process is still holding.
     */
    beforeValidator: (express) => {
        express.get('/demo/fail', () => {
            throw new Error('deliberate failure, so that a span can carry status ERROR');
        });

        express.get('/demo/flush', (_request, response) => {
            void flushTracing().then(() => response.json({ flushed: true }));
        });
    },
});

// The accounts the demos sign in as, created against whatever stand is in front of this
// process. They are seeded here rather than in each demo so that a demo talks to the
// service over HTTP and nothing else.
const { seedDemoAccounts } = await import(join(DIST, 'users/utils/demo-account.util.js'));

await seedDemoAccounts(app.dataSource);

// The line the parent waits for. Its own layer, so a demo counting application layers
// does not count the harness as one of them.
log.info({ base_url: app.baseUrl }, 'demo app listening');

const close = async () => {
    await flushTracing();
    await app.close();
    process.exit(0);
};

process.on('SIGTERM', () => void close());
process.on('SIGINT', () => void close());
