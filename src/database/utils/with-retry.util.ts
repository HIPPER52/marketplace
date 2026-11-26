import type { DataSource, EntityManager } from 'typeorm';

/**
 * TypeORM declares this union at typeorm/driver/types/IsolationLevel but does not re-export
 * it from the package root. Spelled out here rather than reached for through a deep import
 * into the library's internals, which is not a path the package promises to keep.
 */
export type IsolationLevel =
    | 'READ UNCOMMITTED'
    | 'READ COMMITTED'
    | 'REPEATABLE READ'
    | 'SERIALIZABLE';

/**
 * The two SQLSTATEs that mean "nothing is wrong, do it again".
 *
 *   40001 serialization_failure — a REPEATABLE READ or SERIALIZABLE snapshot went stale
 *                                against a concurrent writer
 *   40P01 deadlock_detected     — two transactions waited on each other and Postgres
 *                                picked one to kill
 *
 * Both describe a transaction that was *not* applied and whose inputs are still valid, so
 * running it again is the correct and complete response. Nothing else belongs here. A
 * 23514 check_violation means the data broke a business rule and will break it again; a
 * 55P03 lock_not_available means the caller explicitly asked not to wait. Retrying either
 * turns a clear failure into a slow one.
 */
const RETRYABLE_CODES = new Set(['40001', '40P01']);

const DEFAULT_MAX_ATTEMPTS = 5;
const BACKOFF_BASE_MS = 25;
const BACKOFF_JITTER_MS = 25;

export interface RetryAttempt {
    attempt: number;
    code: string;
    message: string;
    backoffMs: number;
}

export interface WithRetryOptions {
    /** Shown in the log line for each retry. */
    label: string;
    isolation?: IsolationLevel;
    maxAttempts?: number;
    onRetry?: (attempt: RetryAttempt) => void;
}

/**
 * Runs the whole transaction, and runs it again from the top if Postgres says to.
 *
 * From the top is the point: the retry re-reads as well as re-writes. Replaying only the
 * write would reuse values read under a snapshot the database has already rejected, which
 * is a lost update wearing a retry's clothes.
 */
export async function withRetry<T>(
    dataSource: DataSource,
    options: WithRetryOptions,
    run: (manager: EntityManager) => Promise<T>,
): Promise<T> {
    const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    const isolation = options.isolation;

    for (let attempt = 1; ; attempt += 1) {
        try {
            return isolation === undefined
                ? await dataSource.transaction(run)
                : await dataSource.transaction(isolation, run);
        } catch (error: unknown) {
            const code = pgErrorCode(error);

            if (code === undefined || !RETRYABLE_CODES.has(code) || attempt >= maxAttempts) {
                throw error;
            }

            const backoffMs = Math.round(
                2 ** attempt * BACKOFF_BASE_MS + Math.random() * BACKOFF_JITTER_MS,
            );

            options.onRetry?.({
                attempt,
                code,
                message:
                    error instanceof Error ? (error.message.split('\n')[0] ?? '') : String(error),
                backoffMs,
            });

            await sleep(backoffMs);
        }
    }
}

/** True when the error is one this module would have retried — for reporting, not control. */
export function isRetryableCode(code: string | undefined): boolean {
    return code !== undefined && RETRYABLE_CODES.has(code);
}

export function pgErrorCode(error: unknown): string | undefined {
    if (typeof error !== 'object' || error === null) {
        return undefined;
    }

    // node-postgres hangs `code` off the error; TypeORM wraps it in QueryFailedError and
    // copies the driver error onto `driverError`.
    const candidate = error as { code?: unknown; driverError?: { code?: unknown } };
    const code = candidate.code ?? candidate.driverError?.code;

    return typeof code === 'string' ? code : undefined;
}

export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
