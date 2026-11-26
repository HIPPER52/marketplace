import type { Algorithm } from 'jsonwebtoken';

/**
 * The one algorithm this service will accept, as a list of one.
 *
 * **The allowlist is the defence, not the library.** Verification without an explicit
 * `algorithms` lets the token choose how it is checked — which is the whole of the
 * algorithm-confusion family: `alg: none`, or an RS256 verifier handed an HS256 token
 * signed with the public key it publishes. RFC 8725 §3.1 says a library MUST let the
 * caller pin the set; pinning it is one line, and it is the line.
 *
 * ES256 rather than RS256 because OWASP's JWT cheat sheet marks RS256 "Not recommended"
 * and points at ES256 / PS256 / EdDSA. It is also four times smaller on the wire — about
 * 204 bytes against 460 — which matters for a header sent on every request.
 */
export const JWT_ALGORITHMS: readonly Algorithm[] = ['ES256'];

/** Who issued the token, and who it is for. Both are verified, not decorative. */
export const JWT_ISSUER = 'marketplace-api';
export const JWT_AUDIENCE = 'marketplace-api';

/**
 * How long an access token lives.
 *
 * Fifteen minutes is the window a revoked token would survive *if nothing else were
 * done* — which is exactly why something else is done: logout also writes the token's
 * `jti` to a denylist. Short TTL and a denylist are not alternatives; they are the same
 * answer at two scales, and the TTL is what bounds how long the denylist has to remember.
 */
export const ACCESS_TTL_SEC = 15 * 60;

/**
 * The absolute lifetime of a refresh family.
 *
 * Absolute, not sliding. Rotation re-issues a refresh token on every use, so without a
 * deadline that outlives no rotation the "session" never ends — a stolen token that is
 * refreshed once a day is a permanent account. Every rotation inherits the family's
 * original deadline rather than starting a new one.
 */
export const REFRESH_TTL_SEC = 30 * 24 * 60 * 60;

/** Bytes of entropy in a refresh token. 32 → 43 characters of base64url. */
export const REFRESH_BYTES = 32;

/** The header a bearer token arrives in, and the scheme it must use (RFC 6750). */
export const BEARER_PREFIX = 'Bearer ';

/** The `token_type` the contract declares. The spec pins it to one value; so does this. */
export const BEARER_SCHEME = 'Bearer';
