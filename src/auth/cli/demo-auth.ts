import 'reflect-metadata';
import { generateKeyPairSync } from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { TokenPairResponse } from '../../common/types/api.types';
import { emit, finish } from '../../common/utils/demo-report.util';
import { DEMO_BUYER_EMAIL, DEMO_PASSWORD } from '../../users/constants/demo-accounts.constant';
import { seedDemoAccounts } from '../../users/utils/demo-account.util';
import { JWT_AUDIENCE, JWT_ISSUER } from '../constants/auth.constant';
import { call, openDemoApp } from '../utils/demo-app.util';

/**
 * A token's whole life, against the running service.
 *
 *   npm run demo:auth
 *
 * Login, a protected read, three forgeries, and a logout that takes the token back. The
 * forgeries are the part worth having: an `alg: none` token and a token signed by another
 * key are each a complete, well-formed JWT that a verifier written one line shorter would
 * accept. The run fails the process if either is accepted, so "we pinned the algorithm"
 * is a measurement rather than a claim.
 */
async function main(): Promise<void> {
    const stand = await openDemoApp();

    try {
        await seedDemoAccounts(stand.dataSource);

        // ---- the password is the only way in ------------------------------------------
        const wrong = await call(stand, 'POST', '/auth/login', {
            body: { email: DEMO_BUYER_EMAIL, password: `${DEMO_PASSWORD}-not` },
        });

        const login = await call<TokenPairResponse>(stand, 'POST', '/auth/login', {
            body: { email: DEMO_BUYER_EMAIL, password: DEMO_PASSWORD },
        });

        const access = login.body?.access_token ?? '';
        const refresh = login.body?.refresh_token ?? '';

        console.log(`logged in: access ${access.length} chars, refresh ${refresh.length} chars`);

        // ---- who the token says we are -------------------------------------------------
        const me = await call<{ role: string }>(stand, 'GET', '/auth/me', { token: access });

        // ---- a protected read, with and without -----------------------------------------
        const anonymous = await call(stand, 'GET', '/orders');
        const challenge = anonymous.headers.get('www-authenticate') ?? '';
        const authenticated = await call(stand, 'GET', '/orders', { token: access });

        console.log(`\nGET /orders without a token: ${anonymous.status} ${challenge}`);

        // ---- three forgeries -------------------------------------------------------------
        const tampered = await call(stand, 'GET', '/auth/me', { token: flipSignature(access) });
        const none = await call(stand, 'GET', '/auth/me', { token: algNone(access) });
        const foreign = await call(stand, 'GET', '/auth/me', { token: signedElsewhere(access) });

        console.log('forgeries:');
        console.log(`  signature flipped       -> ${tampered.status}`);
        console.log(`  alg: none, same claims  -> ${none.status}`);
        console.log(`  valid ES256, other key  -> ${foreign.status}`);

        // ---- logout takes it back ---------------------------------------------------------
        const loggedOut = await call(stand, 'POST', '/auth/logout', {
            token: access,
            body: { refresh_token: refresh },
        });

        const afterLogout = await call(stand, 'GET', '/auth/me', { token: access });
        const refreshAfterLogout = await call(stand, 'POST', '/auth/refresh', {
            body: { refresh_token: refresh },
        });

        console.log(
            `\nafter logout: the access token answers ${afterLogout.status} although it does ` +
                'not expire for minutes, because its jti is on the denylist',
        );

        emit({
            wrong_password: wrong.status,
            login: login.status,
            me: me.status,
            role: me.body?.role ?? 'none',
            no_token: anonymous.status,
            with_token: authenticated.status,
            tampered: tampered.status,
            alg_none: none.status,
            foreign_key: foreign.status,
            logout: loggedOut.status,
            after_logout: afterLogout.status,
            refresh_after_logout: refreshAfterLogout.status,
        });

        const failures: string[] = [];

        if (wrong.status !== 401) {
            failures.push(`a wrong password was answered with ${wrong.status}, not 401`);
        }

        if (login.status !== 200 || access === '' || refresh === '') {
            failures.push('login did not return a usable pair');
        }

        if (me.status !== 200) {
            failures.push(`GET /auth/me with a fresh token answered ${me.status}`);
        }

        if (anonymous.status !== 401) {
            failures.push(`a protected read without a token answered ${anonymous.status}, not 401`);
        }

        if (!challenge.toLowerCase().startsWith('bearer')) {
            failures.push('the 401 carried no WWW-Authenticate: Bearer (RFC 6750 §3)');
        }

        if (authenticated.status !== 200) {
            failures.push(`a protected read with a token answered ${authenticated.status}`);
        }

        for (const [what, result] of [
            ['a tampered signature', tampered],
            ['an alg: none token', none],
            ['a token signed by another key', foreign],
        ] as const) {
            if (result.status !== 401) {
                failures.push(`${what} was answered with ${result.status}, not 401 — accepted`);
            }
        }

        if (loggedOut.status !== 204) {
            failures.push(`logout answered ${loggedOut.status}, not 204`);
        }

        if (afterLogout.status !== 401) {
            failures.push(
                `the access token still worked after logout (${afterLogout.status}): the ` +
                    'denylist did not take',
            );
        }

        if (refreshAfterLogout.status !== 401) {
            failures.push(
                `the refresh token still worked after logout (${refreshAfterLogout.status})`,
            );
        }

        finish(
            failures,
            'a password buys a pair, the pair opens a protected route, three well-formed\n' +
                'forgeries are refused with 401, and logout ends both halves of the session —\n' +
                'the signature by denylisting its jti, the family by revoking it.',
        );
    } finally {
        await stand.close();
    }
}

/** The same token with one character of its signature changed. */
function flipSignature(token: string): string {
    const parts = token.split('.');
    const signature = parts[2] ?? '';
    const first = signature[0] === 'A' ? 'B' : 'A';

    return `${parts[0]}.${parts[1]}.${first}${signature.slice(1)}`;
}

/**
 * The classic: the token's own claims, `alg` set to `none`, and no signature at all.
 *
 * A verifier called without an explicit `algorithms` list reads `alg` out of the header
 * and does what it is told — which is to check nothing. This is the attack the one line
 * in TokenSigner exists to stop.
 */
function algNone(token: string): string {
    const payload = jwt.decode(token) as Record<string, unknown>;
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const claims = Buffer.from(JSON.stringify({ ...payload, role: 'admin' })).toString('base64url');

    return `${header}.${claims}.`;
}

/**
 * A genuine ES256 token, correct in every respect except who signed it.
 *
 * Everything a verifier checks without the key passes: the issuer, the audience, the
 * expiry, even the algorithm. Only the signature fails, which is the whole point of
 * holding one.
 */
function signedElsewhere(token: string): string {
    const payload = jwt.decode(token) as { sub: string; role: string };
    const { privateKey } = generateKeyPairSync('ec', {
        namedCurve: 'P-256',
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
    });

    return jwt.sign({ role: payload.role }, privateKey, {
        algorithm: 'ES256',
        subject: payload.sub,
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
        expiresIn: 900,
        jwtid: 'forged',
    });
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exit(1);
});
