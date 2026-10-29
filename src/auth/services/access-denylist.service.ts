import { Inject, Injectable } from '@nestjs/common';
import type { Scripted } from '../../cache/utils/script.util';
import { REDIS_QUEUE } from '../../redis/constants/redis.constants';

/** `deny:<jti>` — namespaced like every other key in this repository. */
const denyKey = (jti: string): string => `deny:${jti}`;

/**
 * Access tokens that have been revoked before they expired.
 *
 * ## Why this exists at all
 *
 * An access token cannot be un-signed: the signature stays mathematically valid until
 * `exp`, and nothing the issuer does changes that. Logout therefore cannot *invalidate* a
 * token — it can only arrange for the token to be refused, which means somebody has to
 * remember the refusal. That somebody is this.
 *
 * ## The price, stated plainly
 *
 * The service stops being stateless. That is the real cost, not the milliseconds: an
 * `EXISTS` is an order of magnitude dearer than verifying a signature and both are still
 * fractions of a millisecond. RFC 7009 §3 puts it as "the cost of revocation … is
 * ultimately the result of the desired security properties" — there is no free option,
 * only a choice of bill.
 *
 * ## Two details that are not details
 *
 * The TTL is **the remainder of the token's life, and not one second more**. A denylist
 * bounded by how long tokens live stays a fixed size however many are issued; one bounded
 * by nothing grows until somebody notices.
 *
 * It lives on the `noeviction` instance. A denylist entry dropped by an LRU is a revoked
 * token that works again, which is the one failure this component may not have — and the
 * instance that is forbidden to evict already exists for the queue.
 */
@Injectable()
export class AccessDenylist {
    constructor(@Inject(REDIS_QUEUE) private readonly redis: Scripted) {}

    /** @param exp the token's `exp` claim, in unix seconds */
    async revoke(jti: string, exp: number): Promise<void> {
        const ttl = Math.max(1, exp - Math.floor(Date.now() / 1000));

        await this.redis.set(denyKey(jti), '1', 'EX', ttl);
    }

    async isRevoked(jti: string): Promise<boolean> {
        // Fail closed would mean an unreachable Redis logs everybody out; fail open would
        // mean it quietly un-revokes them. The latter is the smaller, shorter-lived harm —
        // bounded by the access token's fifteen minutes — and it is the behaviour of a
        // service whose authentication does not fall over when a cache does. The choice is
        // named here rather than discovered during an incident.
        try {
            return (await this.redis.exists(denyKey(jti))) === 1;
        } catch {
            return false;
        }
    }
}
