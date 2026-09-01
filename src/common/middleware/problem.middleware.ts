import type { NextFunction, Request, Response } from 'express';
import { describe } from '../errors/problem.error';

export function problemErrorMiddleware(
    error: unknown,
    req: Request,
    res: Response,
    next: NextFunction,
): void {
    if (res.headersSent) {
        next(error);
        return;
    }

    const body = describe(error);

    res.status(body.status)
        .type('application/problem+json')
        .json({
            ...body,
            instance: req.originalUrl,
        });
}
