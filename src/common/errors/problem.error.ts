import type { Problem } from '../types/api.types';

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

export const TITLE_BY_STATUS: Record<number, { title: string; type: string }> = {
    400: { title: 'Request validation failed', type: ProblemType.validation },
    404: { title: 'Resource not found', type: ProblemType.notFound },
    422: { title: 'Unprocessable entity', type: ProblemType.unprocessable },
};

export function describe(error: unknown): Omit<Problem, 'instance'> {
    if (error instanceof ProblemError) {
        return {
            type: error.type,
            title: error.title,
            status: error.status,
            detail: error.message,
        };
    }

    const candidate = error as { status?: number; message?: string };
    const status = candidate.status ?? 500;
    const known = TITLE_BY_STATUS[status];

    return {
        type: known?.type ?? ProblemType.internal,
        title: known?.title ?? 'Internal server error',
        status,
        detail: candidate.message ?? 'Unexpected error.',
    };
}
