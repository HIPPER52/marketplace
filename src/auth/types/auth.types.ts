import type { Role } from '../constants/role.constant';

/** What a verified access token says. Identity, and a cached hint about the role. */
export interface AccessClaims {
    /** The user id. `sub` because RFC 7519 says so, and SDKs look for it there. */
    sub: string;
    /**
     * The role at the moment the token was signed.
     *
     * **A cache, never the basis of a decision.** Guards read the role from the database,
     * so a demotion takes effect on the next request rather than at the next `exp`. This
     * claim exists so a UI can hide a button it would otherwise have to discover is
     * forbidden; the server does not trust it.
     */
    role: Role;
    /** The token's unique id — the denylist key, and what a log may safely carry. */
    jti: string;
    iat: number;
    exp: number;
}

/** What the caller is, once a request has been authenticated. */
export interface Principal {
    userId: string;
    /** Read from the database at decision time, not from the token. */
    role: Role;
    jti: string;
    /**
     * When the presented token stops being valid, in unix seconds.
     *
     * Carried through because logout needs it: a denylist entry is only useful until the
     * token would have expired anyway, so `exp - now` is its TTL. Remembering a revoked
     * token for longer than it could have been used is paying storage for nothing.
     */
    exp: number;
}

export interface TokenPair {
    accessToken: string;
    refreshToken: string;
    /** Seconds the access token is good for, as OAuth 2 names it. */
    expiresIn: number;
}
