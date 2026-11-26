import { createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import jwt from 'jsonwebtoken';
import { emit } from './lib/emit.mjs';
import { REPO_ROOT } from './lib/stack.mjs';

/**
 * The short-lived identity a pipeline deploys with, and the policy that decides whether
 * to believe it.
 *
 * ## What this replaces
 *
 * A long-lived access key in a repository secret is a password with no expiry, no
 * subject and no audience: whoever reads it is the pipeline, for ever, from anywhere.
 * Rotating it is a calendar reminder somebody eventually stops honouring. OIDC removes
 * the stored credential altogether — the runner asks GitHub for a token **about this
 * run**, the cloud verifies that token's signature against GitHub's published keys, and
 * hands back credentials that expire in an hour. There is nothing in the repository to
 * steal, because the thing that proves identity did not exist a minute ago and will not
 * exist a minute from now.
 *
 * ## The three claims, and why all three
 *
 * - **`iss`** — who signed it. Pinned to GitHub's issuer, and the signature is checked
 *   against the JWKS *that issuer publishes*, not against a key pasted into a config.
 * - **`aud`** — who it is for. A token minted for one cloud must not be replayable at
 *   another, which is the whole purpose of an audience, and it is the claim people most
 *   often leave at its default and therefore shared with every other repository on the
 *   platform.
 * - **`sub`** — which repository, on which branch or in which environment. This is the
 *   only claim that distinguishes *this* project's pipeline from any other GitHub
 *   Actions run anywhere in the world. A trust policy that checks `iss` and `aud` and
 *   not `sub` trusts all of GitHub.
 *
 * `algorithms: ['RS256']` is pinned on the verify, for the reason #24 spells out at
 * length: without it the token chooses how it is checked. Same lesson, different issuer.
 *
 * ## Two ways in
 *
 * On a runner, as a step: it asks the runner for a token, verifies it, and prints the
 * claims — **never the token**, which is a bearer credential and would be a credential
 * in a log. Locally, `npm run demo:oidc` imports `verifyToken` and hands it three tokens
 * it minted itself, because this machine is not GitHub and cannot be. What the demo
 * substitutes is the identity provider; what it does not touch is the policy, which is
 * read from `oidc/policy.json` unchanged in both cases.
 */

const POLICY_FILE = join(REPO_ROOT, 'oidc', 'policy.json');

/** The algorithm allowlist. One entry, and the point is that there is a list at all. */
const ALGORITHMS = ['RS256'];

/** The audience a token must be minted for; also what the runner is asked to mint. */
export const DEPLOY_AUDIENCE = 'sts.amazonaws.com';

/**
 * The trust policy, as this gate needs to read it.
 *
 * It is `oidc/policy.json` — an ordinary IAM role trust policy, the document you paste
 * into AWS — rather than a bespoke format invented for a demo. One file, read by the
 * cloud and by this gate, so a subject added in one place cannot be missing from the
 * other. That is the same rule the rest of this repository follows about generated types
 * and about `userlist.txt`.
 */
export class TrustPolicy {
    constructor(issuer, audiences, subjects) {
        this.issuer = issuer;
        this.audiences = audiences;
        this.subjects = subjects;
    }

    /**
     * The two conditions the policy document actually carries.
     *
     * The issuer is deliberately not among them, and its absence is the design rather
     * than an omission: in AWS the issuer is pinned by *registering* the OIDC provider —
     * it is the host in the Federated ARN, and it decides whose published keys the
     * signature is checked against. By the time anything reaches this method the token
     * has already been verified against exactly that issuer's JWKS, so comparing the
     * claim again would be re-asking a question whose answer is the reason we have
     * claims at all. What is left for the Condition block is `aud` and `sub`, which is
     * precisely what the Condition block contains.
     */
    allows(claims) {
        return this.audiences.includes(claims.aud) && this.subjects.includes(claims.sub);
    }
}

/** What a verification answers with. Two independent facts, and they are not the same one. */
export class OidcVerdict {
    constructor(sigVerified, policyAllow, claims, reason) {
        this.sigVerified = sigVerified;
        this.policyAllow = policyAllow;
        this.claims = claims;
        this.reason = reason;
    }
}

/** A claim in an IAM condition may be one string or a list of them. */
function asList(value) {
    if (value === undefined) {
        return [];
    }

    return Array.isArray(value) ? value : [value];
}

export function loadPolicy(file = POLICY_FILE) {
    const document = JSON.parse(readFileSync(file, 'utf8'));
    const statement = document.Statement?.find((entry) => entry.Effect === 'Allow');

    if (statement === undefined) {
        throw new Error(`${file} has no Allow statement`);
    }

    // The issuer is not a field of its own: in a trust policy it is the host at the end
    // of the federated provider's ARN, which is the only place AWS records it. Reading it
    // from there rather than repeating it beside the ARN is what stops the two drifting.
    const federated = statement.Principal?.Federated ?? '';
    const host = federated.split('oidc-provider/')[1];

    if (host === undefined || host === '') {
        throw new Error(`${file}: Principal.Federated is not an oidc-provider ARN`);
    }

    const equals = statement.Condition?.StringEquals ?? {};
    const audiences = asList(equals[`${host}:aud`]);
    const subjects = asList(equals[`${host}:sub`]);

    if (audiences.length === 0 || subjects.length === 0) {
        throw new Error(
            `${file}: the Allow statement must constrain both ${host}:aud and ${host}:sub. ` +
                'A policy that checks the issuer and the audience but not the subject trusts ' +
                'every repository on GitHub.',
        );
    }

    return new TrustPolicy(`https://${host}`, audiences, subjects);
}

async function getJson(uri) {
    const response = await fetch(uri);

    if (!response.ok) {
        throw new Error(`${uri} answered ${response.status}`);
    }

    return response.json();
}

/**
 * Where the issuer says its keys are — asked, never assumed.
 *
 * This is the one piece of the chain that cannot be guessed, and guessing it is how this
 * gate failed the first time it met a real runner. `/.well-known/jwks.json` is the
 * convention a dozen providers follow and GitHub is not one of them: it answers 404
 * there and publishes at `/.well-known/jwks`, which is exactly why OpenID Connect
 * Discovery defines a document whose whole job is to say so. The issuer is a constant;
 * the path under it is the issuer's business.
 *
 * `/.well-known/openid-configuration` is the discovery document's fixed location (OpenID
 * Connect Discovery 1.0 §4), so there is precisely one convention relied on here instead
 * of two, and it is the one that is actually standardised.
 */
async function discoverJwksUri(issuer) {
    const discovery = await getJson(`${issuer}/.well-known/openid-configuration`);
    const uri = discovery.jwks_uri;

    if (typeof uri !== 'string' || uri === '') {
        throw new Error(`${issuer} publishes no jwks_uri in its discovery document`);
    }

    return uri;
}

async function fetchKeys(uri) {
    const document = await getJson(uri);
    return Array.isArray(document.keys) ? document.keys : [];
}

/**
 * Verifies a token's signature against the issuer's published keys, then asks the policy.
 *
 * The two answers are separate on purpose and the demo prints both. A valid signature
 * means "GitHub really minted this"; it says nothing about *which* run it was minted
 * for, and a gate that stopped there would accept a token issued to a stranger's
 * repository — a real and frequently published misconfiguration rather than a theoretical
 * one. The policy answers the second question, and only the pair is an authorisation.
 *
 * The **issuer** is overridable, because `npm run demo:oidc` cannot be
 * token.actions.githubusercontent.com — and it is the only thing that is. Everything
 * downstream of it is discovered or decided: the key location comes from that issuer's
 * discovery document, and the audience and the list of subjects come from the committed
 * policy. An earlier version let the caller override the JWKS address too, which meant
 * the demo supplied the one value that was wrong in production and the bug could not be
 * reproduced anywhere but on a runner. One substitution, at the top.
 */
export async function verifyToken(token, policy, overrides = {}) {
    const issuer = overrides.issuer ?? policy.issuer;
    const jwksUri = await discoverJwksUri(issuer);

    const header = jwt.decode(token, { complete: true })?.header;

    if (header === undefined) {
        return new OidcVerdict(false, false, {}, 'the token is not a JWT');
    }

    const keys = await fetchKeys(jwksUri);
    const jwk = keys.find((candidate) => candidate.kid === header.kid);

    if (jwk === undefined) {
        return new OidcVerdict(false, false, {}, `no key with kid=${header.kid} at ${jwksUri}`);
    }

    let claims;

    try {
        claims = jwt.verify(token, createPublicKey({ key: jwk, format: 'jwk' }), {
            algorithms: ALGORITHMS,
            issuer,
        });
    } catch (error) {
        return new OidcVerdict(false, false, {}, error.message);
    }

    // Claims are read only after the signature holds. Reading them first and deciding on
    // them afterwards is how an unverified token's `sub` ends up in an audit log looking
    // exactly like a verified one.
    const seen = { iss: claims.iss, aud: claims.aud, sub: claims.sub };
    const allowed = policy.allows(seen);

    return new OidcVerdict(
        true,
        allowed,
        seen,
        allowed ? 'signature and policy both hold' : `sub=${seen.sub} is not a trusted subject`,
    );
}

/**
 * Asks the runner for a token about this run.
 *
 * The request itself is authenticated with `ACTIONS_ID_TOKEN_REQUEST_TOKEN`, which the
 * runner only sets when the job declares `permissions: id-token: write` — that
 * declaration is why this is `undefined` in every other job, and the message says so
 * rather than reporting a failed fetch.
 */
async function requestRunnerToken(audience) {
    const url = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
    const bearer = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;

    if (url === undefined || bearer === undefined) {
        throw new Error(
            'no OIDC token available: this is not a runner, or the job does not declare ' +
                'permissions: id-token: write',
        );
    }

    const response = await fetch(`${url}&audience=${encodeURIComponent(audience)}`, {
        headers: { authorization: `Bearer ${bearer}` },
    });

    if (!response.ok) {
        throw new Error(`the runner's token endpoint answered ${response.status}`);
    }

    const { value } = await response.json();
    return value;
}

async function main() {
    const policy = loadPolicy();
    const token = await requestRunnerToken(DEPLOY_AUDIENCE);
    const verdict = await verifyToken(token, policy);

    // The claims, and never the token. A JWT in a log is a bearer credential in a log,
    // and an artifact anybody with read access to the repository can download.
    emit('creds-source', 'oidc');
    emit('oidc-iss', verdict.claims.iss ?? '');
    emit('oidc-aud', verdict.claims.aud ?? '');
    emit('oidc-sub', verdict.claims.sub ?? '');
    emit('oidc-sig-verified', verdict.sigVerified ? 1 : 0);
    emit('oidc-sub-trusted', verdict.policyAllow ? 1 : 0);

    if (!verdict.sigVerified) {
        throw new Error(`the runner's own token did not verify: ${verdict.reason}`);
    }

    /**
     * Whether an untrusted subject is fatal depends on which pipeline is asking, and
     * both answers are right.
     *
     * `oidc/policy.json` trusts `refs/heads/main` and the production environment. A pull
     * request's token is about a pull request, so on a PR this prints
     * `oidc-sub-trusted=0` — the control working, not a failure. The pipeline that runs
     * somebody's proposed code **must not** be able to assume the role that deploys, and
     * failing there would mean the only way to get a green PR was to widen the policy
     * until it trusted every branch. So the PR pipeline records the 0 and carries on.
     *
     * The release pipeline sets `OIDC_REQUIRE_TRUSTED_SUB=1` and the same 0 stops it.
     * On main the token's subject is one the policy names; if it is not, something is
     * wrong with the trigger, the environment or the policy, and the honest response to
     * "I cannot prove which run this is" is to not deploy.
     */
    if (process.env.OIDC_REQUIRE_TRUSTED_SUB === '1' && !verdict.policyAllow) {
        throw new Error(
            `${verdict.reason}. oidc/policy.json trusts: ${policy.subjects.join(', ')}`,
        );
    }
}

// Only when run as a command. `npm run demo:oidc` imports the two exports above and
// supplies its own identity provider, because this laptop is not GitHub.
if (process.argv[1]?.endsWith('oidc-gate.mjs')) {
    main().catch((error) => {
        console.error(`\noidc gate failed: ${error.message}\n`);
        process.exitCode = 1;
    });
}
