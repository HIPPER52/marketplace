import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { BEARER_PREFIX } from '../../auth/constants/auth.constant';
import { TokenSigner } from '../../auth/services/token-signer.service';
import { ProblemError, ProblemType } from '../../common/errors/problem.error';
import { RATE_LIMIT_EXEMPT } from '../constants/rate-limit.constant';
import { RATE_LIMITER } from '../constants/rate-limit.token';
import type { SlidingWindowLimiter } from '../services/sliding-window.service';

/**
 * Where the limit is spent.
 *
 * A Nest guard rather than Express middleware in front of the validator, for one reason
 * worth the extra hop: a guard's refusal travels back through `ProblemFilter` and
 * therefore through `validateResponses`, so the 429 this throws is checked against the
 * contract that declares it. A middleware answering before the validator would have made
 * that declaration decorative.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
    constructor(
        @Inject(RATE_LIMITER) private readonly limiter: SlidingWindowLimiter,
        private readonly signer: TokenSigner,
    ) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const request = context.switchToHttp().getRequest<Request>();

        if (RATE_LIMIT_EXEMPT.test(request.path)) {
            return true;
        }

        const decision = await this.limiter.take(clientOf(request, this.signer));

        if (decision.allowed) {
            return true;
        }

        const seconds = Math.max(1, Math.ceil(decision.retryAfterMs / 1000));

        throw new ProblemError({
            status: 429,
            type: ProblemType.rateLimited,
            title: 'Too many requests',
            detail:
                `Allowance of ${this.limiter.limit} requests per ` +
                `${this.limiter.windowMs / 1000} s is spent. Retry in ${seconds} s.`,
            headers: { 'Retry-After': String(seconds) },
        });
    }
}

/**
 * Who is being limited.
 *
 * The token's subject when the signature holds, the address otherwise. Until #24 this
 * read `X-User-Id` — a bucket a client could change by typing a different number, which
 * made the limit opt-in. A signature cannot be typed, so the only way to get a fresh
 * allowance now is to present no token at all, and that falls to the address.
 *
 * Signature only: no denylist lookup and no `SELECT`. This runs ahead of authentication
 * on every request, and a limiter that costs a Redis round trip and a database read to
 * decide which counter to increment costs more than most of the work it protects. A
 * revoked token still names the person it was issued to, which is all a bucket needs.
 *
 * `req.ip` is only meaningful behind a proxy when Express is told to trust one. This stand
 * has no proxy; the day it does, `trust proxy` is the line that stops every request
 * looking like it came from the load balancer.
 */
function clientOf(request: Request, signer: TokenSigner): string {
    const header = request.headers.authorization;
    const token =
        typeof header === 'string' && header.startsWith(BEARER_PREFIX)
            ? signer.subjectOf(header.slice(BEARER_PREFIX.length))
            : null;

    if (token !== null) {
        return `user:${token}`;
    }

    return `ip:${request.ip ?? 'unknown'}`;
}
