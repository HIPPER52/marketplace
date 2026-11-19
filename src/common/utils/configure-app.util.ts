import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import express, { type Express } from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import { httpMetricsMiddleware } from '../../observability/middleware/http-metrics.middleware';
import { requestContextMiddleware } from '../../observability/middleware/request-context.middleware';
import { ProblemFilter } from '../filters/problem.filter';
import { problemErrorMiddleware } from '../middleware/problem.middleware';

/**
 * Three levels up from this file in either tree: dist/common/utils and src/common/utils
 * are both three deep, so the compiled server and the test suite read the same document.
 */
const SPEC_PATH = join(__dirname, '..', '..', '..', 'openapi', 'openapi.yaml');

/**
 * Everything between `NestFactory.create` and `listen`, in one place so that the E2E
 * suite can build the same application the production entry point does.
 *
 * It is not a tidy-up. The order below is load-bearing, and two of the four steps were
 * found the hard way:
 *
 *   - express.json() by hand, because the app is created with `bodyParser: false`. Nest
 *     registers its own parser during init(), which runs after these use() calls, so the
 *     validator would otherwise read an empty body and reject every POST with
 *     "request must have required property 'body'".
 *   - the error middleware after init(), because the validator is plain Express
 *     middleware sitting outside Nest's exception pipeline. Its rejections — request and
 *     response alike — need a handler registered behind the routes. Controller-thrown
 *     errors are a different path and are handled by ProblemFilter.
 *
 * An E2E suite that assembled this itself would drift from main.ts, and the day it did,
 * the tests would be describing an application nobody deploys.
 */
/**
 * Named, and it has exactly one member, because exactly one thing needs to happen between
 * two of the steps below.
 */
export interface ConfigureOptions {
    /**
     * Registered **after** the instrumentation and **before** the contract validator.
     *
     * That window exists for one caller: `demo/children/app-child.mjs`, which needs an
     * endpoint that answers 5xx — OpenTelemetry leaves a span's status `Unset` for a 4xx,
     * so only a server error demonstrates an ERROR span — and this service deliberately
     * has no route whose job is to fail. Registering it here rather than in `src/` keeps
     * that true: production passes nothing, the validator would 404 anything added later
     * because it is not in the contract, and anything added earlier would be invisible to
     * the metrics and the trace, which is the whole of what is being measured.
     */
    beforeValidator?: (express: Express) => void;
}

export async function configureApp(
    app: INestApplication,
    options: ConfigureOptions = {},
): Promise<void> {
    /**
     * Observability first, ahead of the body parser and ahead of the validator.
     *
     * A request the OpenAPI validator refuses never reaches Nest, so instrumentation
     * mounted any later counts a service that has no validation failures in it and logs
     * nothing about the 400 the client is looking at. These two are also the only
     * middleware here that must see *every* request, including the ones nothing serves.
     */
    app.use(requestContextMiddleware);
    app.use(httpMetricsMiddleware);

    app.use(express.json());

    options.beforeValidator?.(app.getHttpAdapter().getInstance());

    app.use(
        OpenApiValidator.middleware({
            apiSpec: SPEC_PATH,
            validateRequests: true,
            validateResponses: true,

            // Authentication is the guard's, not the validator's.
            //
            // Left on, the validator answers its own 401 ("Authorization header
            // required") the moment a path declares `security`, before any guard runs.
            // It is checking the only thing it can — that a header is present — and that
            // is not the question: a present header holding an expired, forged or
            // revoked token must also be 401, and all four refusals have to carry
            // `WWW-Authenticate: Bearer` (RFC 6750 §3), which its answer does not.
            //
            // Two things answering 401 with different details and different headers is a
            // contract honoured twice and kept once. The spec still declares `security`
            // and the 401 it produces — that declaration is what `validateResponses`
            // holds the guard's answer to.
            validateSecurity: false,
            // /health and /readiness are operational and are not in the contract.
            //
            // /socket.io is the trap worth naming. Socket.IO does not open with a
            // WebSocket: Engine.IO starts on HTTP long-polling and upgrades afterwards,
            // so the very first request is GET /socket.io/?EIO=4&transport=polling. The
            // validator finds no such path in the spec, answers 404, the upgrade never
            // happens — and the symptom is a client that silently never connects.
            ignorePaths: /^\/(health|readiness|metrics)$|^\/socket\.io(\/|$)/,
        }),
    );

    app.useGlobalFilters(new ProblemFilter());

    await app.init();
    app.getHttpAdapter().getInstance().use(problemErrorMiddleware);
}
