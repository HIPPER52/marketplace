import express, { type Express, type Request, type Response } from 'express';

const PORT = Number(process.env.PORT ?? 3000);

export function createApp(): Express {
    const app = express();

    app.get('/health', (_req: Request, res: Response) => {
        res.json({ status: 'ok' });
    });

    return app;
}

createApp().listen(PORT, () => {
    console.log(`marketplace-api listening on http://localhost:${PORT}`);
});
