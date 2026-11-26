import 'reflect-metadata';
import { setTimeout as delay } from 'node:timers/promises';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { configureApp } from './common/utils/configure-app.util';
import type { Env } from './config/schemas/env.schema';
import { Lifecycle } from './health/services/lifecycle.service';

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
    const { AppModule } = await import('./app.module');

    const app = await NestFactory.create(AppModule, { bodyParser: false, abortOnError: false });

    // The same four steps the E2E suite applies — see configure-app.util.ts.
    await configureApp(app);

    const config = app.get(ConfigService<Env, true>);
    const port = config.get('PORT', { infer: true });
    const warmupMs = config.get('WARMUP_MS', { infer: true });
    const drainMs = config.get('DRAIN_MS', { infer: true });

    // Before the warm-up, not after: a SIGTERM that arrives while this process is still
    // getting ready has to be answered too, and an orchestrator is entitled to send one.
    installShutdown(app, app.get(Lifecycle), drainMs);

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
        console.log(`[warmup] ${warmupMs} ms before the socket opens`);
        await delay(warmupMs);
    }

    await app.listen(port);
    console.log(`Server listening on port: ${port}`);
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
            console.log(`[shutdown] ${signal}: readiness red, draining for ${drainMs} ms`);
            lifecycle.beginDraining();
            await delay(drainMs);

            await Promise.race([app.close(), delay(CLOSE_TIMEOUT_MS)]);
            console.log('[shutdown] socket closed');
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
