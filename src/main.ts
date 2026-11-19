import 'reflect-metadata';
// First, and before anything else in this process is loaded.
//
// Auto-instrumentation patches modules as they are required, so a module already in the
// cache is a module nobody patched — start the SDK after `express` has been imported and
// the HTTP spans silently never appear. That is why every other import in this file is a
// dynamic one inside `bootstrap`, and why this one is at the top.
import { startTracing } from './observability/utils/tracing.util';

startTracing();

import { setTimeout as delay } from 'node:timers/promises';
import type { INestApplication } from '@nestjs/common';
import type { Env } from './config/schemas/env.schema';
import type { Lifecycle } from './health/services/lifecycle.service';

/**
 * How long to wait for the server to finish closing before giving up on it.
 *
 * It is a backstop, not a budget: the drain above it is what the orchestrator's grace
 * period is sized against. Without it a single connection that never ends would hold the
 * process open until SIGKILL, and the exit code would say 137 for a shutdown that did
 * everything right.
 */
const CLOSE_TIMEOUT_MS = 10_000;

async function bootstrap(): Promise<void> {
    const { ConfigService } = await import('@nestjs/config');
    const { NestFactory } = await import('@nestjs/core');
    const { configureApp } = await import('./common/utils/configure-app.util');
    const { Lifecycle: LifecycleToken } = await import('./health/services/lifecycle.service');
    const { NestPinoLogger } = await import('./observability/services/nest-logger.service');
    const { rootLogger } = await import('./observability/utils/logger.util');
    const { AppModule } = await import('./app.module');

    const app = await NestFactory.create(AppModule, {
        bodyParser: false,
        abortOnError: false,
        // Nest's own lines go through the same logger as everything else, so the whole of
        // stdout is JSON — `demo:logs` counts `non-json-lines` and must find none.
        logger: new NestPinoLogger(),
    });

    // The same four steps the E2E suite applies — see configure-app.util.ts.
    await configureApp(app);

    const config = app.get(ConfigService<Env, true>);
    const port = config.get('PORT', { infer: true });
    const warmupMs = config.get('WARMUP_MS', { infer: true });
    const drainMs = config.get('DRAIN_MS', { infer: true });
    const log = rootLogger.child({ layer: 'bootstrap' });

    // Before the warm-up, not after: a SIGTERM that arrives while this process is still
    // getting ready has to be answered too, and an orchestrator is entitled to send one.
    installShutdown(app, app.get(LifecycleToken), drainMs);

    /**
     * Deliberately between "the application is built" and "the socket is open".
     *
     * A real deployment is not ready the moment its process exists — a pool is still
     * filling, a cache is still cold, a migration check is still running — and a rollout
     * that assumes otherwise is the first of the two holes it has. Putting the wait here
     * rather than after `listen()` is what makes the difference observable: during it
     * there is no listener at all, so a load balancer that was told this pod is ready
     * gets a refused connection rather than a slow answer, which is exactly what happens
     * to a real service with no readiness probe.
     *
     * Zero by default. It is the cluster that sets it, because it is the cluster that has
     * a probe to notice.
     */
    if (warmupMs > 0) {
        log.info({ warmup_ms: warmupMs }, 'warming up before the socket opens');
        await delay(warmupMs);
    }

    await app.listen(port);
    log.info({ port }, 'server listening');
}

/**
 * The order below is the whole of a zero-failure rollout, and it is not cosmetic.
 *
 * 1. readiness turns red, so the EndpointSlice controller stops handing this pod's IP out;
 * 2. the drain runs with the socket still open, so requests already on their way — and the
 *    ones a load balancer sends in the interval before it notices — are answered;
 * 3. only then does the socket close.
 *
 * Closing at step 1 is the common mistake: it refuses connections during the window in
 * which the balancer is still sending them, and the client sees a dropped connection
 * rather than a 503. Kubernetes does not promise to remove an endpoint before it sends
 * SIGTERM — the two are separate controllers running in parallel — so the drain is the
 * only thing standing in that gap.
 *
 * `terminationGracePeriodSeconds` must exceed the drain. Smaller, and SIGKILL lands in the
 * middle of it: exit 137 and connections cut, which is the opposite of what this is for.
 */
function installShutdown(app: INestApplication, lifecycle: Lifecycle, drainMs: number): void {
    let shuttingDown = false;

    const handle = (signal: NodeJS.Signals): void => {
        if (shuttingDown) {
            return;
        }

        shuttingDown = true;

        void (async () => {
            const { rootLogger } = await import('./observability/utils/logger.util');
            const { flushTracing } = await import('./observability/utils/tracing.util');
            const log = rootLogger.child({ layer: 'bootstrap' });

            log.info({ signal, drain_ms: drainMs }, 'readiness red, draining');
            lifecycle.beginDraining();
            await delay(drainMs);

            await Promise.race([app.close(), delay(CLOSE_TIMEOUT_MS)]);
            // Whatever is still in the exporter's buffer describes requests this process
            // has already answered. Losing it would lose exactly the traces of the
            // shutdown nobody can reproduce afterwards.
            await flushTracing();
            log.info('socket closed');
            process.exit(0);
        })();
    };

    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
        process.on(signal, handle);
    }
}

bootstrap().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\nServer failed to start.\n\n${message}\n`);
    process.exit(1);
});
