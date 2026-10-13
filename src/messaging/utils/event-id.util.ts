import { createHash } from 'node:crypto';

/**
 * A stable identifier for "this thing happened to that entity".
 *
 * Derived, not drawn: `randomUUID()` would hand a republished message a new identity, and
 * a republish is exactly what happens when a confirm is lost and the publisher retries.
 * The consumer would then see two different events describing one order and have no way
 * to tell that from two orders.
 *
 * md5 rather than a random v4, and shaped into the UUID layout so the column can stay
 * `uuid`. The hash is an identifier, not a defence — nothing here depends on it being
 * hard to forge, and db/seed.sql already addresses its rows the same way.
 */
export function deterministicEventId(type: string, subjectId: string): string {
    const digest = createHash('md5').update(`${type}:${subjectId}`).digest('hex');

    return [
        digest.slice(0, 8),
        digest.slice(8, 12),
        digest.slice(12, 16),
        digest.slice(16, 20),
        digest.slice(20, 32),
    ].join('-');
}
