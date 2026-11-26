import { ProblemError, ProblemType } from '../errors/problem.error';
import type { Page } from '../types/pagination.types';

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

/** The cursor is opaque to clients; inside, it is the offset the next page starts at. */
export function readCursor(cursor?: string): number {
    return cursor === undefined ? 0 : decodeCursor(cursor);
}

/**
 * Wraps a page the database has already sliced. `total` is what decides whether there is
 * a next cursor — asking for one row more than the page size would answer the same
 * question, but the count is what `findAndCount` already returns.
 */
export function pageOf<T>(items: T[], offset: number, total: number): Page<T> {
    const consumed = offset + items.length;

    return {
        items,
        next_cursor: consumed < total ? encodeCursor(consumed) : null,
    };
}

const DEFAULT_LIMIT = 20;

export function readLimit(raw: unknown): number {
    return raw === undefined ? DEFAULT_LIMIT : Number(raw);
}
