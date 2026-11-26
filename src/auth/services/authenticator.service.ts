import { Injectable } from '@nestjs/common';
import { ProblemError, ProblemType } from '../../common/errors/problem.error';
import { UsersRepository } from '../../users/repositories/users.repository';
import { BEARER_PREFIX } from '../constants/auth.constant';
import type { AccessClaims, Principal } from '../types/auth.types';
import { AccessDenylist } from './access-denylist.service';
import { TokenSigner } from './token-signer.service';

/**
 * Turning a token into a caller. The one chain, used by every transport.
 *
 * Four things have to be true, and each answers a different question:
 *
 *   1. a bearer token is present — RFC 6750 semantics: whoever holds it is the claim;
 *   2. its signature verifies against the **pinned** algorithm list, and `iss`/`aud`/`exp`
 *      match — this is the part cryptography can decide;
 *   3. its `jti` is not on the denylist — the part cryptography cannot, because a
 *      signature stays valid until `exp` no matter what the issuer has since decided;
 *   4. the account still exists, and **its role is read from the database**.
 *
 * Step 4 is the one worth defending. Reading the role from the token would be free and
 * would be wrong: a demoted admin keeps whatever the token says until it expires. One
 * query makes the decision current, and it is the same query an ownership check needs
 * anyway.
 *
 * This is a service rather than code inside the guard because a guard is an HTTP thing
 * and the same question is asked over a WebSocket handshake. Two copies of this chain
 * would be two places to forget `algorithms`, and the second copy is always the one that
 * ships without it.
 */
@Injectable()
export class Authenticator {
    constructor(
        private readonly signer: TokenSigner,
        private readonly denylist: AccessDenylist,
        private readonly users: UsersRepository,
    ) {}

    /** The token out of an `Authorization` header, or null if there is not one. */
    bearer(header: unknown): string | null {
        return typeof header === 'string' && header.startsWith(BEARER_PREFIX)
            ? header.slice(BEARER_PREFIX.length)
            : null;
    }

    /** Throws a 401 problem for anything that is not a currently usable token. */
    async identify(token: string): Promise<Principal> {
        let claims: AccessClaims;

        try {
            claims = this.signer.verify(token);
        } catch (error: unknown) {
            // Expired, tampered with, signed by somebody else, or nominating an algorithm
            // this service does not accept — all of them are "not recognised".
            throw unauthenticated(
                `Access token is not valid: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }

        if (await this.denylist.isRevoked(claims.jti)) {
            throw unauthenticated('Access token was revoked.');
        }

        const account = await this.users.byId(claims.sub);

        if (account === null) {
            throw unauthenticated('The account this token belongs to no longer exists.');
        }

        return { userId: account.id, role: account.role, jti: claims.jti, exp: claims.exp };
    }

    /**
     * The same chain, answering `null` instead of throwing.
     *
     * For transports that have no error middleware behind them: a socket.io handshake
     * carries no status code, so the gateway turns a `null` into its own refusal rather
     * than letting a ProblemError escape into a frame nobody reads.
     */
    async tryIdentify(token: unknown): Promise<Principal | null> {
        if (typeof token !== 'string' || token.trim() === '') {
            return null;
        }

        try {
            return await this.identify(token.trim());
        } catch {
            return null;
        }
    }
}

export function unauthenticated(detail: string): ProblemError {
    return new ProblemError({
        status: 401,
        type: ProblemType.unauthenticated,
        title: 'Not authenticated',
        detail,
        // RFC 6750 §3: a 401 from a bearer-protected resource says which scheme it wants.
        headers: { 'WWW-Authenticate': 'Bearer' },
    });
}
