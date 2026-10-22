import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { ProblemError, ProblemType } from '../../common/errors/problem.error';
import { USER_ID_HEADER } from '../../orders/constants/realtime.constant';
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
    constructor(@Inject(RATE_LIMITER) private readonly limiter: SlidingWindowLimiter) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const request = context.switchToHttp().getRequest<Request>();

        if (RATE_LIMIT_EXEMPT.test(request.path)) {
            return true;
        }

        const decision = await this.limiter.take(clientOf(request));

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
 * The claimed identity when there is one, the address otherwise. Both are as trustworthy
 * as the client is honest — the same caveat `ClaimedIdentityService` carries — and that is
 * acceptable for a limit in a way it would not be for an ownership check: the worst a liar
 * achieves is a larger allowance, not somebody else's data.
 *
 * `req.ip` is only meaningful behind a proxy when Express is told to trust one. This stand
 * has no proxy; the day it does, `trust proxy` is the line that stops every request
 * looking like it came from the load balancer.
 */
function clientOf(request: Request): string {
    const claimed = request.headers[USER_ID_HEADER.toLowerCase()];

    if (typeof claimed === 'string' && claimed.trim() !== '') {
        return `user:${claimed.trim()}`;
    }

    return `ip:${request.ip ?? 'unknown'}`;
}
