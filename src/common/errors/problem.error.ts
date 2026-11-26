import type { Problem } from '../types/api.types';

const BASE = 'https://api.marketplace.local/problems';

export const ProblemType = {
    validation: `${BASE}/validation-error`,
    unauthenticated: `${BASE}/unauthenticated`,
    forbidden: `${BASE}/forbidden`,
    notFound: `${BASE}/not-found`,
    conflict: `${BASE}/conflict`,
    unprocessable: `${BASE}/unprocessable-entity`,
    idempotencyConflict: `${BASE}/idempotency-key-conflict`,
    idempotencyInFlight: `${BASE}/idempotency-key-in-flight`,
    rateLimited: `${BASE}/too-many-requests`,
    internal: `${BASE}/internal-error`,
} as const;

/** Everything needed to build one RFC 7807 document. */
export interface ProblemInit {
    status: number;
    type: string;
    title: string;
    detail: string;
    /** See `ProblemError.headers`. */
    headers?: Record<string, string>;
}

export class ProblemError extends Error {
    readonly status: number;
    readonly type: string;
    readonly title: string;
    /**
     * Headers the answer must carry.
     *
     * One case needs it and the contract says so: a 429 declares `Retry-After` as
     * required, and a refusal that does not say when to come back is a refusal the client
     * can only answer by guessing.
     */
    readonly headers: Record<string, string>;

    constructor(args: ProblemInit) {
        super(args.detail);
        this.name = 'ProblemError';
        this.status = args.status;
        this.type = args.type;
        this.title = args.title;
        this.headers = args.headers ?? {};
    }
}

export const TITLE_BY_STATUS: Record<number, { title: string; type: string }> = {
    400: { title: 'Request validation failed', type: ProblemType.validation },
    401: { title: 'Not authenticated', type: ProblemType.unauthenticated },
    403: { title: 'Forbidden', type: ProblemType.forbidden },
    404: { title: 'Resource not found', type: ProblemType.notFound },
    409: { title: 'Conflict', type: ProblemType.conflict },
    422: { title: 'Unprocessable entity', type: ProblemType.unprocessable },
    429: { title: 'Too many requests', type: ProblemType.rateLimited },
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
