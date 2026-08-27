import { ProblemError, ProblemType } from './problem.js';


export function encodeCursor(offset: number): string {
    return Buffer.from(`offset:${offset}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): number {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^offset:(\d+)$/.exec(decoded);

    if (!match?.[1]) {
        throw new ProblemError({
            status: 400,
            type: ProblemType.validation,
            title: 'Request validation failed',
            detail: 'The cursor is not a token this API issued. Pass back a next_cursor verbatim.',
        });
    }

    return Number(match[1]);
}

export interface Page<T> {
    items: T[];
    next_cursor: string | null;
}

export function paginate<T>(all: readonly T[], limit: number, cursor?: string): Page<T> {
    const offset = cursor === undefined ? 0 : decodeCursor(cursor);
    const items = all.slice(offset, offset + limit);
    const consumed = offset + items.length;

    return {
        items,
        next_cursor: consumed < all.length ? encodeCursor(consumed) : null,
    };
}

const DEFAULT_LIMIT = 20;

export function readLimit(raw: unknown): number {
    return raw === undefined ? DEFAULT_LIMIT : Number(raw);
}
