import 'reflect-metadata';
import type { TokenPairResponse } from '../../common/types/api.types';
import { emit, finish } from '../../common/utils/demo-report.util';
import { DEMO_BUYER_EMAIL, DEMO_PASSWORD } from '../../users/constants/demo-accounts.constant';
import { seedDemoAccounts } from '../../users/utils/demo-account.util';
import { RefreshTokensRepository } from '../repositories/refresh-tokens.repository';
import { call, openDemoApp } from '../utils/demo-app.util';

/**
 * Rotation, and what happens when a spent token comes back.
 *
 *   npm run demo:reuse
 *
 * Rotation on its own guarantees nothing. If a stolen refresh token is used first, the
 * thief gets a fresh pair, the honest client's next refresh fails, the honest client
 * quietly signs in again — and the thief's session carries on. That is a tidier failure,
 * not a safer one.
 *
 * What makes it a defence is treating a *reused* token as evidence that two parties hold
 * it, and killing everything descended from that login. RFC 9700 §4.14.2 requires exactly
 * this and is equally plain about the price: the legitimate client has to sign in again.
 * This run measures both halves — the replay is refused, **and** the pair the thief
 * already obtained stops working.
 */
async function main(): Promise<void> {
    const stand = await openDemoApp();

    try {
        await seedDemoAccounts(stand.dataSource);

        const login = await call<TokenPairResponse>(stand, 'POST', '/auth/login', {
            body: { email: DEMO_BUYER_EMAIL, password: DEMO_PASSWORD },
        });

        const first = login.body.refresh_token;

        // The honest rotation: one call, a new pair, the old token spent.
        const rotated = await call<TokenPairResponse>(stand, 'POST', '/auth/refresh', {
            body: { refresh_token: first },
        });

        const second = rotated.body?.refresh_token ?? '';

        console.log(`rotated: ${short(first)} -> ${short(second)}`);
        console.log(`the new token is a different string: ${String(first !== second)}`);

        // Somebody replays the token that was already spent. Which of the two parties is
        // in front of us cannot be known, so neither keeps the session.
        const replay = await call(stand, 'POST', '/auth/refresh', {
            body: { refresh_token: first },
        });

        // And the pair handed out a moment ago — the one a thief would be holding — is
        // dead too, because it belongs to the same family.
        const descendant = await call(stand, 'POST', '/auth/refresh', {
            body: { refresh_token: second },
        });

        const tokens = stand.app.get(RefreshTokensRepository);
        const familyId = await familyOf(stand, first, tokens);
        const family = await tokens.familyState(familyId);

        console.log(
            `\nreplay answered ${replay.status}, the descendant answered ${descendant.status}`,
        );
        console.log(`family ${familyId}: ${family.rows} tokens, ${family.live} still usable`);

        // Signing in again works: the account is fine, the session was what died.
        const again = await call<TokenPairResponse>(stand, 'POST', '/auth/login', {
            body: { email: DEMO_BUYER_EMAIL, password: DEMO_PASSWORD },
        });

        // `r1` is the refresh token login handed out and `r2` is the one that replaced
        // it — the assignment's names, kept so that `grep -qx 'r1-reuse=401'` matches.
        emit({
            rotate: rotated.status,
            'rotated-differs': Number(first !== second),
            'r1-reuse': replay.status,
            'r2-after-reuse': descendant.status,
            'family-rows': family.rows,
            'family-live': family.live,
            'login-again': again.status,
        });

        const failures: string[] = [];

        if (rotated.status !== 200 || second === '') {
            failures.push(`the first rotation answered ${rotated.status} and no new pair`);
        }

        if (first === second) {
            failures.push('the "new" refresh token is the old one: nothing rotated');
        }

        if (replay.status !== 401) {
            failures.push(`replaying a spent token answered ${replay.status}, not 401`);
        }

        if (descendant.status !== 401) {
            failures.push(
                `the pair issued before the replay still works (${descendant.status}): the ` +
                    'family was not revoked, so a thief who moved first keeps the session',
            );
        }

        if (family.live !== 0) {
            failures.push(`${family.live} tokens of the revoked family are still usable`);
        }

        if (again.status !== 200) {
            failures.push(
                `signing in again answered ${again.status}: revoking a family must cost a ` +
                    'login, not the account',
            );
        }

        finish(
            failures,
            `one login, ${family.rows} refresh tokens, 0 of them alive. A replay is read as two\n` +
                'parties holding one credential, so the whole family goes — which costs the\n' +
                'honest client a login and costs the thief the session.',
        );
    } finally {
        await stand.close();
    }
}

/** Which family the first token belonged to. Read through the same hash the table stores. */
async function familyOf(
    stand: Awaited<ReturnType<typeof openDemoApp>>,
    token: string,
    tokens: RefreshTokensRepository,
): Promise<string> {
    const rows = await stand.dataSource.query<{ family_id: string }[]>(
        'SELECT family_id FROM refresh_tokens WHERE token_hash = $1',
        [tokens.fingerprintOf(token)],
    );

    return rows[0]?.family_id ?? 'none';
}

function short(token: string): string {
    return `${token.slice(0, 8)}…`;
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exit(1);
});
