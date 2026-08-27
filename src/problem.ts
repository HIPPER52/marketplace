import type { NextFunction, Request, Response } from 'express';
import type { components } from './generated/api.js';

export type Problem = components['schemas']['Problem'];

const BASE = 'https://api.marketplace.local/problems';

export const ProblemType = {
    validation: `${BASE}/validation-error`,
    notFound: `${BASE}/not-found`,
    unprocessable: `${BASE}/unprocessable-entity`,
    idempotencyConflict: `${BASE}/idempotency-key-conflict`,
    internal: `${BASE}/internal-error`,
} as const;


export class ProblemError extends Error {
    readonly status: number;
    readonly type: string;
    readonly title: string;

    constructor(args: { status: number; type: string; title: string; detail: string }) {
        super(args.detail);
        this.name = 'ProblemError';
        this.status = args.status;
        this.type = args.type;
        this.title = args.title;
    }
}

export function sendProblem(req: Request, res: Response, problem: Omit<Problem, 'instance'>): void {
    res.status(problem.status)
        .type('application/problem+json')
        .json({
            ...problem,
            instance: req.originalUrl,
        });
}

interface ValidatorError {
    status?: number;
    message?: string;
    name?: string;
}

const TITLE_BY_STATUS: Record<number, { title: string; type: string }> = {
    400: { title: 'Request validation failed', type: ProblemType.validation },
    404: { title: 'Resource not found', type: ProblemType.notFound },
    422: { title: 'Unprocessable entity', type: ProblemType.unprocessable },
};

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
    if (err instanceof ProblemError) {
        sendProblem(req, res, {
            type: err.type,
            title: err.title,
            status: err.status,
            detail: err.message,
        });
        return;
    }

    const validatorError = err as ValidatorError;
    const status = validatorError.status ?? 500;
    const known = TITLE_BY_STATUS[status];

    sendProblem(req, res, {
        type: known?.type ?? ProblemType.internal,
        title: known?.title ?? 'Internal server error',
        status,
        detail: validatorError.message ?? 'Unexpected error.',
    });
}
