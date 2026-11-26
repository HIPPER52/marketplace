/**
 * How a refresh ends.
 *
 * A tag rather than a literal for the reason every other discriminant in this repository
 * is one — see CLAUDE.md, "No magic values" — and for one specific to this union: the
 * three outcomes are handled in two different places, inside the transaction that decides
 * and outside the one that acts, and a typo in one of two copies of `'reuse'` would
 * compile and would silently stop revoking families.
 */
export const RefreshOutcome = {
    /** A new pair was issued and the presented token is spent. */
    Rotated: 'rotated',
    /** The token was already used: two parties hold it, and the family must die. */
    Reuse: 'reuse',
    /** Unknown, expired or already revoked. Nothing to do but refuse. */
    Rejected: 'rejected',
} as const;

export type RefreshOutcome = (typeof RefreshOutcome)[keyof typeof RefreshOutcome];
