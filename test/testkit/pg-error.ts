/**
 * The SQLSTATE behind a rejected query.
 *
 * TypeORM wraps the driver's error in a QueryFailedError and copies its fields across,
 * but the original is also hung off `driverError` — reading both is cheaper than
 * depending on which version does which.
 */
export function sqlStateOf(error: unknown): string | undefined {
    const candidate = error as { code?: string; driverError?: { code?: string } };
    return candidate.code ?? candidate.driverError?.code;
}

/** Postgres error codes this suite names out loud. */
export const UNIQUE_VIOLATION = '23505';
export const FOREIGN_KEY_VIOLATION = '23503';
export const CHECK_VIOLATION = '23514';
