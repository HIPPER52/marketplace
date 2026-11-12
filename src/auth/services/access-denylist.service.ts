import { Inject, Injectable, Logger } from '@nestjs/common';
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
 *
 * ## This is a dual write, and it is the one from #22
 *
 * Logout writes two stores: the refresh family is a row in Postgres and the `jti` is a key
 * here. No transaction spans them, so the failure mode is exact and worth stating rather
 * than discovering — **Redis unreachable means the family is dead and the access token
 * already in the caller's hand keeps working until its `exp`.** Signing in again is
 * impossible; the session that is open stays open, for up to `ACCESS_TTL_SEC`.
 *
 * #22's cure does not transfer, and the reason is worth knowing. An outbox works because
 * the consumer can be made idempotent and the relay can retry forever; here the second
 * store is read on **every request**, and a denylist miss is the common case — a
 * read-through to Postgres would put a `SELECT` on the hot path of every authenticated
 * call to cover a row that almost never exists. That is paying for the exception on every
 * instance of the rule.
 *
 * So the dual write stays, and three things bound it instead:
 *
 *   - the **order**: the durable half (the family) is written first, so a failure costs a
 *     window that closes by itself rather than a session that can refresh forever;
 *   - the **TTL on the access token**: fifteen minutes is the whole exposure, which is
 *     what makes a short-lived access token worth its refresh traffic;
 *   - a **loud failure**: the write below logs an incident and rethrows, so logout answers
 *     an error rather than `204`, and the client's retry re-runs both halves — the family
 *     revocation is idempotent, so a retry is free.
 *
 * What would actually remove it is not a bigger Redis. It is revocation pushed to every
 * instance — a list each process holds in memory and refreshes, so there is no second
 * store to be out of step with. That is a #28-shaped change, and it is not pretended here.
 */
@Injectable()
export class AccessDenylist {
    private readonly logger = new Logger(AccessDenylist.name);

    constructor(@Inject(REDIS_QUEUE) private readonly redis: Scripted) {}

    /**
     * Refuses this token for the rest of its life.
     *
     * **Does not swallow a failure.** `isRevoked` fails open because a request has to be
     * answered; this one has nothing to answer, so the honest thing is to say the second
     * half of the logout did not happen. The caller sees an error, retries, and the retry
     * re-runs a family revocation that is idempotent — which is a better outcome than a
     * `204` over a token that still works.
     *
     * @param exp the token's `exp` claim, in unix seconds
     */
    async revoke(jti: string, exp: number): Promise<void> {
        const ttl = Math.max(1, exp - Math.floor(Date.now() / 1000));

        try {
            await this.redis.set(denyKey(jti), '1', 'EX', ttl);
        } catch (error: unknown) {
            // The family is already revoked and committed by the time this runs, so the
            // line below is the whole record of the window: this token works for another
            // `ttl` seconds and nothing else will say so.
            this.logger.error(
                `[INCIDENT] denylist_write_failed jti=${jti} ttl=${ttl}s ` +
                    `reason=${error instanceof Error ? error.message : String(error)}`,
            );

            throw error;
        }
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
