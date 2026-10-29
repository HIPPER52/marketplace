import { Inject, Injectable, Logger } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { ProblemError, ProblemType } from '../../common/errors/problem.error';
import { DATA_SOURCE } from '../../database/constants/database.constants';
import { UsersRepository } from '../../users/repositories/users.repository';
import { REFRESH_TTL_SEC } from '../constants/auth.constant';
import { RefreshOutcome } from '../constants/outcome.constant';
import { RefreshTokensRepository } from '../repositories/refresh-tokens.repository';
import type { Principal, TokenPair } from '../types/auth.types';
import { AccessDenylist } from './access-denylist.service';
import { PasswordService } from './password.service';
import { TokenSigner } from './token-signer.service';

/**
 * Login, rotation with replay detection, and a logout that is two actions.
 *
 * ## Rotation, and why the family exists
 *
 * Every refresh issues a new pair and spends the old one. On its own that guarantees
 * nothing: if a stolen token is used first, the thief gets a fresh pair, the honest
 * client's next refresh fails, and the honest client quietly signs in again — while the
 * **thief's session carries on**. Rotation without detection is a tidier failure, not a
 * safer one.
 *
 * So a token that was already spent arriving again is read as what it is: two parties hold
 * the same credential. The response is to revoke the whole family, which costs the honest
 * user a login and costs the thief the session. RFC 9700 §4.14.2 requires exactly this and
 * is equally plain about the price — "this stops the attack at the cost of forcing the
 * legitimate client to obtain a fresh authorization grant".
 *
 * ## No grace window
 *
 * Two parallel requests from one client can both try to refresh the same token, which
 * looks identical to a replay. Some implementations answer with a few seconds of grace in
 * which the same token returns the same new pair. This one does not: the row is claimed
 * `FOR UPDATE`, so the second request waits, sees the mark, and the family dies. The
 * client is expected to serialise its refreshes — one in-flight promise shared by every
 * waiting request — and the reason to prefer that is that a grace window treats a real
 * replay as a race whenever the thief is quick.
 */
@Injectable()
export class AuthService {
    private readonly logger = new Logger(AuthService.name);

    constructor(
        @Inject(DATA_SOURCE) private readonly dataSource: DataSource,
        private readonly users: UsersRepository,
        private readonly passwords: PasswordService,
        private readonly tokens: RefreshTokensRepository,
        private readonly signer: TokenSigner,
        private readonly denylist: AccessDenylist,
    ) {}

    async login(email: string, password: string): Promise<TokenPair> {
        const account = await this.users.byEmail(email);
        const ok = await this.passwords.matches(password, account?.passwordHash ?? null);

        // One answer for "no such person" and for "wrong password". Telling them apart is
        // telling an attacker which half of a guess was right.
        if (account === null || !ok) {
            throw unauthorized('Email or password is wrong.');
        }

        const familyId = this.tokens.newFamily();

        return this.issuePair(account.id, account.role, familyId, this.deadline());
    }

    async refresh(presented: string): Promise<TokenPair> {
        const outcome = await this.dataSource.transaction(
            async (manager): Promise<RefreshDecision> => {
                const row = await this.tokens.claim(manager, presented);

                if (row === null) {
                    return reject('Refresh token is not recognised.');
                }

                if (row.revokedAt !== null) {
                    return reject('Refresh token was revoked.');
                }

                if (row.expiresAt.getTime() <= Date.now()) {
                    return reject('Refresh token has expired.');
                }

                if (row.usedAt !== null) {
                    // Two parties hold this token. The revocation deliberately does not
                    // happen here — see below.
                    return {
                        outcome: RefreshOutcome.Reuse,
                        familyId: row.familyId,
                        userId: row.userId,
                    };
                }

                await this.tokens.markUsed(manager, row.id);

                const account = await this.users.byId(row.userId);

                if (account === null) {
                    return reject('The account this token belongs to is gone.');
                }

                // The family's original deadline, carried through unchanged. Extending it
                // here is how "rotate often" silently becomes "never expires".
                return {
                    outcome: RefreshOutcome.Rotated,
                    pair: await this.issuePair(
                        account.id,
                        account.role,
                        row.familyId,
                        row.expiresAt,
                        manager,
                    ),
                };
            },
        );

        if (outcome.outcome === RefreshOutcome.Reuse) {
            // **A revocation that rolls back has revoked nothing.**
            //
            // The obvious shape is to revoke the family and throw, both inside the
            // transaction above. It does not work, and it fails silently: the throw
            // aborts the transaction, Postgres undoes the UPDATE, and the log line still
            // says `revoked=2`. Measured — the replay was refused and the pair the thief
            // was already holding kept working, which is precisely the attack this is
            // supposed to stop.
            //
            // So the detection decides and a separate, committed transaction acts.
            const revoked = await this.dataSource.transaction((manager) =>
                this.tokens.revokeFamily(manager, outcome.familyId),
            );

            this.logger.warn(
                `[INCIDENT] refresh_reuse_detected family=${outcome.familyId} ` +
                    `user=${outcome.userId} revoked=${revoked}`,
            );

            throw unauthorized('Refresh token was already used.');
        }

        if (outcome.outcome === RefreshOutcome.Rejected) {
            throw unauthorized(outcome.detail);
        }

        return outcome.pair;
    }

    /**
     * Logout is **two actions against two stores**, and they are not atomic.
     *
     * The refresh family is a row in Postgres and the access token's `jti` is a key in
     * Redis; no transaction spans both — this is the dual write of #22, met again where it
     * cannot be removed. What can be chosen is the order, and the order is reasoned:
     *
     *   - family first. If the second step fails, the access token lives until its `exp`
     *     and **no new ones can be minted** — a bounded window that closes by itself.
     *   - the other way round, a failure would leave a session that can keep refreshing
     *     itself forever while its current access token is refused. Unbounded.
     *
     * So the durable fact goes first and the best-effort one second, and the residual
     * window is named rather than hidden.
     */
    async logout(principal: Principal, refreshToken: string): Promise<void> {
        await this.dataSource.transaction(async (manager) => {
            const row = await this.tokens.claim(manager, refreshToken);

            // Somebody else's refresh token is silently not revoked rather than refused:
            // telling a caller which strings are live tokens is telling them how to test
            // a guess.
            if (row !== null && row.userId === principal.userId) {
                await this.tokens.revokeFamily(manager, row.familyId);
            }
        });

        await this.denylist.revoke(principal.jti, principal.exp);
    }

    private deadline(): Date {
        return new Date(Date.now() + REFRESH_TTL_SEC * 1_000);
    }

    private async issuePair(
        userId: string,
        role: Parameters<TokenSigner['sign']>[1],
        familyId: string,
        expiresAt: Date,
        manager = this.dataSource.manager,
    ): Promise<TokenPair> {
        const refreshToken = this.tokens.mint();
        await this.tokens.issue(manager, refreshToken, { userId, familyId, expiresAt });

        const access = this.signer.sign(userId, role);

        return { accessToken: access.token, refreshToken, expiresIn: access.expiresIn };
    }
}

/** What the deciding transaction hands back for the calling method to act on. */
type RefreshDecision =
    | { outcome: typeof RefreshOutcome.Rotated; pair: TokenPair }
    | { outcome: typeof RefreshOutcome.Reuse; familyId: string; userId: string }
    | { outcome: typeof RefreshOutcome.Rejected; detail: string };

function reject(detail: string): RefreshDecision {
    return { outcome: RefreshOutcome.Rejected, detail };
}

/**
 * Always 401, never 403.
 *
 * Everything in this file is a failure to establish *who* — an unknown password, an
 * unrecognised token, a revoked one. A 403 would tell a client's SDK "we know you and the
 * answer is still no", and the SDK would stop trying to refresh and log the person out.
 */
function unauthorized(detail: string): ProblemError {
    return new ProblemError({
        status: 401,
        type: ProblemType.unauthenticated,
        title: 'Not authenticated',
        detail,
    });
}
