import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { configureApp } from './common/utils/configure-app.util';
import type { Env } from './config/schemas/env.schema';

async function bootstrap(): Promise<void> {
    const { AppModule } = await import('./app.module');

    const app = await NestFactory.create(AppModule, { bodyParser: false, abortOnError: false });

    // The same four steps the E2E suite applies — see configure-app.util.ts.
    await configureApp(app);

    const config = app.get(ConfigService<Env, true>);
    const port = config.get('PORT', { infer: true });

    await app.listen(port);
    console.log(`Server listening on port: ${port}`);
}

bootstrap().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\nServer failed to start.\n\n${message}\n`);
    process.exit(1);
});
