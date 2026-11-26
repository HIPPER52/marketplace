import { generateKeyPairSync } from 'node:crypto';
import { createServer } from 'node:http';
import jwt from 'jsonwebtoken';
import { emit, fail } from '../scripts/lib/emit.mjs';
import { DEPLOY_AUDIENCE, loadPolicy, verifyToken } from '../scripts/oidc-gate.mjs';

/**
 * Three tokens, one trust policy, and the two questions it answers separately.
 *
 *   npm run demo:oidc
 *
 * A pipeline that deploys with a short-lived federated identity is only as good as the
 * policy on the other side, and a policy nobody has watched refuse anything is a policy
 * nobody knows the shape of. So this mints three tokens against a local identity
 * provider and runs each through `scripts/oidc-gate.mjs` — the same function a runner
 * calls, with the same algorithm allowlist and the same `oidc/policy.json`.
 *
 *   case=green           sig-verified=1  policy-allow=1
 *   case=foreign-sub     sig-verified=1  policy-allow=0
 *   case=bad-signature   sig-verified=0  policy-allow=0
 *
 * The middle row is the one worth staring at. That token is **genuine**: the issuer
 * really minted it, the signature really holds, and an integration that stopped at
 * "GitHub signed this" would hand it the deploy role. What it is not is a token about
 * *this* repository, and `sub` is the only claim that says so. The published
 * misconfiguration this guards against is not exotic — it is a trust policy with the
 * issuer and the audience filled in and the subject left as a wildcard, which trusts
 * every GitHub Actions run on the platform.
 *
 * The bottom row is the forgery: the claims of the top row, the `kid` of the top row,
 * and a signature from a key the issuer never published. It fails at the signature and
 * therefore never reaches the policy at all — `policy-allow=0` there means "not asked",
 * which is the right order to ask the two questions in.
 *
 * What this demo substitutes for GitHub is the **identity provider**, and only its
 * address: a key pair made here, a discovery document and a key set on a loopback port.
 * Where those keys live is discovered rather than passed in, and they are served from a
 * path no convention would guess — an earlier version handed the gate a JWKS address
 * directly, which is how a wrong one survived all the way to a runner. What it does not
 * touch is the policy, which is read from `oidc/policy.json` exactly as written,
 * including which subjects it trusts — the green case takes its subject from that file
 * rather than repeating one.
 */

const KID = 'oidc-demo-key';

/** A case to run: what to call it, the subject it claims, and which key signs it. */
class Scenario {
    constructor(name, subject, signWith, expected) {
        this.name = name;
        this.subject = subject;
        this.signWith = signWith;
        this.expected = expected;
    }
}

/** What each case must answer. Two bits, written down before the run rather than after. */
class Expectation {
    constructor(sigVerified, policyAllow) {
        this.sigVerified = sigVerified;
        this.policyAllow = policyAllow;
    }
}

/** One pair, expressed in the two forms the two sides need: a PEM to sign with, a JWK to publish. */
class DemoKeyPair {
    constructor(privatePem, publicJwk) {
        this.privatePem = privatePem;
        this.publicJwk = publicJwk;
    }
}

function rsaPair() {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

    return new DemoKeyPair(
        privateKey.export({ type: 'pkcs8', format: 'pem' }),
        publicKey.export({ format: 'jwk' }),
    );
}

/**
 * Where this issuer publishes its keys — and deliberately **not** where anybody would
 * guess.
 *
 * `/.well-known/jwks.json` is the convention a dozen providers follow, and the gate used
 * to assume it. GitHub does not: it answers 404 there and publishes at
 * `/.well-known/jwks`, which the first run against a real runner discovered the
 * expensive way. Serving the keys from a path that matches neither is what makes this
 * demo able to catch that class of mistake rather than paper over it — the only way to
 * find them from here is to read the discovery document, which is what the gate now does.
 */
const JWKS_PATH = '/oidc/keys';

/** Fixed by OpenID Connect Discovery 1.0 §4, and the one convention worth relying on. */
const DISCOVERY_PATH = '/.well-known/openid-configuration';

/**
 * The issuer, on a port this process owns: a discovery document and a key set.
 *
 * It publishes the public half of `trusted` and nothing else, which is the entire reason
 * the forged token fails: the verifier looks a key up by `kid`, finds the real one, and
 * checks a signature that was not made with its private half. The forger controls the
 * header, not the key store.
 */
function startIssuer(publicJwk) {
    return new Promise((resolve) => {
        let origin = '';

        const server = createServer((request, response) => {
            let body = null;

            if (request.url === DISCOVERY_PATH) {
                body = { issuer: origin, jwks_uri: `${origin}${JWKS_PATH}` };
            } else if (request.url === JWKS_PATH) {
                body = { keys: [{ ...publicJwk, kid: KID, use: 'sig', alg: 'RS256' }] };
            }

            if (body === null) {
                response.writeHead(404).end();
                return;
            }

            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify(body));
        });

        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            origin = `http://127.0.0.1:${port}`;
            resolve({ server, origin });
        });
    });
}

function mint(privatePem, issuer, subject) {
    return jwt.sign({ sub: subject }, privatePem, {
        algorithm: 'RS256',
        keyid: KID,
        issuer,
        audience: DEPLOY_AUDIENCE,
        expiresIn: '5m',
    });
}

async function main() {
    const policy = loadPolicy();

    // The subject the green case claims is not written here: it is the first one the
    // committed policy trusts. Repeating it would be a second source of truth, and the
    // demo would keep passing on the day somebody narrowed the policy.
    const [trustedSubject] = policy.subjects;

    const trusted = rsaPair();
    const forged = rsaPair();

    const { server, origin } = await startIssuer(trusted.publicJwk);
    // The issuer, and nothing else. Everything past it — which keys, at which address —
    // the gate discovers for itself, exactly as it does against GitHub.
    const overrides = { issuer: origin };

    const scenarios = [
        new Scenario('green', trustedSubject, trusted.privatePem, new Expectation(1, 1)),
        new Scenario(
            'foreign-sub',
            'repo:somebody-else/marketplace:ref:refs/heads/main',
            trusted.privatePem,
            new Expectation(1, 0),
        ),
        new Scenario('bad-signature', trustedSubject, forged.privatePem, new Expectation(0, 0)),
    ];

    let wrong = 0;

    try {
        for (const scenario of scenarios) {
            const token = mint(scenario.signWith, origin, scenario.subject);
            const verdict = await verifyToken(token, policy, overrides);

            const sigVerified = verdict.sigVerified ? 1 : 0;
            const policyAllow = verdict.policyAllow ? 1 : 0;

            emit('case', scenario.name);
            emit('sig-verified', sigVerified);
            emit('policy-allow', policyAllow);

            console.error(`  ${scenario.name}: ${verdict.reason}`);

            if (
                sigVerified !== scenario.expected.sigVerified ||
                policyAllow !== scenario.expected.policyAllow
            ) {
                wrong += 1;
            }
        }
    } finally {
        server.close();
    }

    emit('cases', scenarios.length);
    emit('audience', DEPLOY_AUDIENCE);
    emit('trusted-subjects', policy.subjects.length);

    if (wrong !== 0) {
        fail(
            `${wrong} case(s) did not answer as the policy says they must. ` +
                'The expected matrix is in the header of this file and in the README.',
        );
    }
}

main().catch((error) => {
    console.error(`\ndemo:oidc failed: ${error.message}\n`);
    process.exitCode = 2;
});
