import 'reflect-metadata';
import { join } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import { ProblemFilter } from './common/filters/problem.filter';
import { problemErrorMiddleware } from './common/middleware/problem.middleware';
import type { Env } from './config/schemas/env.schema';

const SPEC_PATH = join(__dirname, '..', 'openapi', 'openapi.yaml');

async function bootstrap(): Promise<void> {
    const { AppModule } = await import('./app.module');

    const app = await NestFactory.create(AppModule, { bodyParser: false, abortOnError: false });
    const config = app.get(ConfigService<Env, true>);

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

    const port = config.get('PORT', { infer: true });
    await app.listen(port);
    console.log(`Server listening on port: ${port}`);
}

bootstrap().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\nServer failed to start.\n\n${message}\n`);
    process.exit(1);
});
