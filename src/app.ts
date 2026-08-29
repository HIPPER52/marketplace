import { fileURLToPath } from 'node:url';
import express, { type Express } from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import { errorHandler } from './problem.js';
import { ordersRouter } from './routes/orders.js';
import { productsRouter } from './routes/products.js';

export const SPEC_PATH = fileURLToPath(new URL('../openapi/openapi.yaml', import.meta.url));

export function createApp(): Express {
    const app = express();

    app.use(express.json());

    app.get('/health', (_req, res) => {
        res.json({ status: 'ok' });
    });

    app.use(
        OpenApiValidator.middleware({
            apiSpec: SPEC_PATH,
            validateRequests: true,
            validateResponses: true,
        }),
    );

    app.use(productsRouter);
    app.use(ordersRouter);

    app.use(errorHandler);

    return app;
}
