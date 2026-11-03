/**
 * What a person is allowed to be.
 *
 * Three, flat, and that is a deliberate ceiling. Roles answer "what kind of actor is
 * this" and they stop being the right tool the moment the answer depends on *which*
 * resource — a seller editing their own listing and a seller editing somebody else's are
 * the same role and must get different answers. That second question is ownership, and it
 * is checked where the resource is, not here.
 *
 * The alternative to that discipline is role explosion: one shop becomes `shop-1-editor`,
 * a hundred shops become two hundred roles, and nobody can answer "who can touch this
 * product" without walking all of them.
 */
export const Role = {
    /** Buys things. The default for anybody who signs up. */
    Customer: 'customer',
    /** Puts things in the catalogue. */
    Seller: 'seller',
    Admin: 'admin',
} as const;

export type Role = (typeof Role)[keyof typeof Role];

export const ROLES = Object.values(Role);

/** Who may write to the catalogue. */
export const CATALOGUE_WRITERS: readonly Role[] = [Role.Seller, Role.Admin];
