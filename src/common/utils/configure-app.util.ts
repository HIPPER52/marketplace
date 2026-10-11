import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
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
export async function configureApp(app: INestApplication): Promise<void> {
    app.use(express.json());

    app.use(
        OpenApiValidator.middleware({
            apiSpec: SPEC_PATH,
            validateRequests: true,
            validateResponses: true,
            ignorePaths: /^\/(health|readiness)$/,
        }),
    );

    app.useGlobalFilters(new ProblemFilter());

    await app.init();
    app.getHttpAdapter().getInstance().use(problemErrorMiddleware);
}
