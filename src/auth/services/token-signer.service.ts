import { createPrivateKey, createPublicKey, type KeyObject, randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import jwt from 'jsonwebtoken';
import type { Env } from '../../config/schemas/env.schema';
import {
    ACCESS_TTL_SEC,
    JWT_ALGORITHMS,
    JWT_AUDIENCE,
    JWT_ISSUER,
} from '../constants/auth.constant';
import type { Role } from '../constants/role.constant';
import type { AccessClaims } from '../types/auth.types';
import { fingerprint } from '../utils/key-fingerprint.util';
import { decodePem } from '../utils/pem.util';

export interface SignedAccess {
    token: string;
    jti: string;
    expiresIn: number;
    /** Unix seconds. What the denylist entry's TTL is computed from. */
    exp: number;
}

/**
 * Signs access tokens, and verifies them.
 *
 * ## The one line that matters
 *
 * `algorithms: JWT_ALGORITHMS` in `verify`. Without it the token chooses how it is
 * checked, and that is the whole algorithm-confusion family: `alg: none` asking for no
 * signature at all, or an RS256 verifier handed an HS256 token signed with the public key
 * it happily publishes. RFC 8725 §3.1 requires libraries to let the caller pin the set,
 * and pinning it is the defence — not the library, which is why the lecture's `jose` run
 * accepted a forged `role: admin` the moment the option was left out.
 *
 * ## Why the key is asymmetric
 *
 * With HS256 the secret that verifies is the secret that signs: every service that checks
 * a token can also write one, and a verifier that was only ever supposed to read could
 * issue itself `role: admin`. That is not an attack, it is the definition of a symmetric
 * MAC. ES256 splits the two — one private key signs, any number of public copies verify —
 * so the blast radius of a leaked verifier is zero.
 *
 * ## What is logged
 *
 * The key's fingerprint, never the key and never a token. A fingerprint is the only way to
 * confirm that a pod picked up a rotated key, and it is derived from the public half, so
 * printing it reveals nothing.
 */
@Injectable()
export class TokenSigner {
    readonly kid: string;
    readonly fingerprint: string;

    private readonly logger = new Logger(TokenSigner.name);
    private readonly privateKey: KeyObject;
    private readonly publicKey: KeyObject;

    constructor(config: ConfigService<Env, true>) {
        this.kid = config.get('JWT_KID', { infer: true });

        const publicPem = decodePem(config.get('JWT_PUBLIC_KEY', { infer: true }));
        this.privateKey = createPrivateKey(
            decodePem(config.get('JWT_PRIVATE_KEY', { infer: true })),
        );
        this.publicKey = createPublicKey(publicPem);
        this.fingerprint = fingerprint(publicPem);

        this.logger.log(
            `signing ${JWT_ALGORITHMS.join('/')} as kid=${this.kid} fp=${this.fingerprint}`,
        );
    }

    sign(userId: string, role: Role): SignedAccess {
        const jti = randomUUID();
        const token = jwt.sign({ role }, this.privateKey, {
            algorithm: JWT_ALGORITHMS[0],
            expiresIn: ACCESS_TTL_SEC,
            issuer: JWT_ISSUER,
            audience: JWT_AUDIENCE,
            subject: userId,
            jwtid: jti,
            // Names the pair that signed this, so a verifier holding two during an overlap
            // knows which to try. Carried in the header, where it is not a secret.
            keyid: this.kid,
        });

        const { exp } = jwt.decode(token) as { exp: number };

        return { token, jti, expiresIn: ACCESS_TTL_SEC, exp };
    }

    /**
     * Who a token says it is for, or null — **signature only**, no denylist and no
     * database.
     *
     * For the two places that need a key rather than a decision: the rate limiter's
     * bucket and the session's "this person was here". Both run before the guard, on
     * every request, and neither is an authorisation: a revoked-but-unexpired token still
     * belongs to the person it was issued to, and a forged one fails the signature and
     * falls back to an address. Paying for a Redis round trip and a `SELECT` to decide
     * which counter to increment would be the limiter costing more than the work it
     * protects.
     */
    subjectOf(token: string): string | null {
        try {
            return this.verify(token).sub;
        } catch {
            return null;
        }
    }

    /** Throws for anything that is not a currently valid token signed by this service. */
    verify(token: string): AccessClaims {
        return jwt.verify(token, this.publicKey, {
            algorithms: [...JWT_ALGORITHMS],
            issuer: JWT_ISSUER,
            audience: JWT_AUDIENCE,
        }) as unknown as AccessClaims;
    }
}
