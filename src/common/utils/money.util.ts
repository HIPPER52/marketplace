import type { ValueTransformer } from 'typeorm';

/**
 * Postgres `bigint` arrives from the driver as a string, because a bigint can exceed
 * Number.MAX_SAFE_INTEGER and the driver refuses to lose precision silently.
 *
 * Money in this project cannot: it is a count of kopiykas, and 9 007 199 254 740 991 of
 * them is ninety trillion hryvnia. So monetary columns convert to `number` on the way
 * out, which is also what openapi.yaml declares them to be (`price_cents: integer`).
 * Identifier columns keep the driver's string — there the width is the point.
 */
export const bigintCents: ValueTransformer = {
    to: (value: number): number => value,
    from: (value: string | null): number | null => (value === null ? null : Number(value)),
};
