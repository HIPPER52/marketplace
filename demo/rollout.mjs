import { spawn } from 'node:child_process';
import { createWriteStream, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emit, fail } from '../scripts/lib/emit.mjs';
import { delay, must } from '../scripts/lib/shell.mjs';
import { KUBE_CONTEXT, REPO_ROOT, STACK } from '../scripts/lib/stack.mjs';

/**
 * Does a release drop requests? The only honest answer is a number.
 *
 *   npm run demo:rollout                  # the correct profile: zero
 *   npm run demo:rollout -- --broken      # the control run: the defaults, and what they cost
 *
 * The shape of the measurement matters more than the numbers in it. A load generator runs
 * against the Service while a new revision is rolled out, and every response code it gets
 * — including the absence of one — goes into a file. The counts at the end are read back
 * out of that file. Nothing here prints a conclusion it did not count, which is why the
 * control run exists at all: a demo whose measurement cannot fail proves nothing, and
 * `--broken` is the same code path with four lines of configuration changed.
 *
 * A failure during a rolling update usually does not look like a 500. The connection is
 * refused or reset, so there is no status code at all — `000`, the way curl writes it.
 * Behind an Ingress or a cloud balancer the same event becomes a 502 or a 503. Hence the
 * count is "responses that were not 200" rather than "five hundreds".
 */

const BROKEN_FLAG = '--broken';
const Profile = { Hardened: 'hardened', Broken: 'broken' };

/** Thirty-two in flight, paced: enough to clear the criterion's floor of five thousand
 * requests inside one rollout, and nowhere near enough to be the thing that breaks it. */
const CONCURRENCY = 32;
const PACE_MS = 20;
const REQUEST_TIMEOUT_MS = 5_000;

/**
 * The load keeps running for at least this long whatever the rollout does. A broken
 * rollout is over in a few seconds, and "zero failures out of nine hundred requests" is
 * not a result — the criterion's own floor is five thousand for the same reason.
 */
const MIN_LOAD_MS = 20_000;

/** And a little after the rollout, because the last pod to go is the one that drops things. */
const TAIL_MS = 2_000;

/** A fixed revision to roll *from*, so every run measures the same kind of change. */
const BASE_REVISION = 'pre';

const NO_RESPONSE = '000';
const OK = '200';

const target = `http://127.0.0.1:${STACK.nodePort}/health`;
const deployment = 'marketplace-api';

/** Named: the load generator produces it and three keys are printed out of it. */
class LoadTally {
    constructor(requests, ok) {
        this.requests = requests;
        this.ok = ok;
    }

    get failed() {
        return this.requests - this.ok;
    }
}

function kubectl(args) {
    return must('kubectl', ['--context', KUBE_CONTEXT, '-n', STACK.namespace, ...args]);
}

function generation() {
    return Number(kubectl(['get', 'deploy', deployment, '-o', 'jsonpath={.metadata.generation}']));
}

/** One request, one line in the file. No keep-alive: every attempt re-resolves an endpoint. */
function probe() {
    return new Promise((resolve) => {
        const attempt = request(
            target,
            { agent: false, timeout: REQUEST_TIMEOUT_MS },
            (response) => {
                response.resume();
                response.on('end', () => resolve(String(response.statusCode)));
                response.on('error', () => resolve(NO_RESPONSE));
            },
        );

        attempt.on('timeout', () => attempt.destroy());
        attempt.on('error', () => resolve(NO_RESPONSE));
        attempt.end();
    });
}

function startLoad(path) {
    const sink = createWriteStream(path, { flags: 'a' });
    let running = true;

    const workers = Array.from({ length: CONCURRENCY }, async () => {
        while (running) {
            sink.write(`${await probe()}\n`);
            await delay(PACE_MS);
        }
    });

    return async () => {
        running = false;
        await Promise.all(workers);
        await new Promise((resolve) => sink.end(resolve));
    };
}

function tallyOf(path) {
    const codes = readFileSync(path, 'utf8')
        .split('\n')
        .filter((line) => line.length > 0);

    return new LoadTally(codes.length, codes.filter((code) => code === OK).length);
}

/** `pulumi up` with the profile and revision this phase wants, through the usual wrapper. */
function deployAsync(profile, revision) {
    const child = spawn('bash', ['scripts/pulumi.sh', 'up'], {
        cwd: REPO_ROOT,
        env: { ...process.env, MARKETPLACE_PROFILE: profile, MARKETPLACE_REV: revision },
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    child.stdout.on('data', (chunk) => {
        output += chunk;
    });
    child.stderr.on('data', (chunk) => {
        output += chunk;
    });

    return new Promise((resolve, reject) => {
        child.on('close', (code) => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`pulumi up exited ${code}\n${output}`));
            }
        });
    });
}

async function deploy(profile, revision) {
    await deployAsync(profile, revision);
}

/**
 * The rollout itself, timed from the moment the cluster is told about it.
 *
 * `metadata.generation` moves when the spec changes, which is the first observable
 * instant of a release — earlier than "pulumi finished" and later than "pulumi started",
 * both of which would time this tool rather than the rolling update.
 */
async function measuredRollout(profile, revision) {
    const before = generation();
    const finished = deployAsync(profile, revision);

    while (generation() === before) {
        await delay(100);
    }

    const started = Date.now();
    kubectl(['rollout', 'status', `deploy/${deployment}`, '--timeout=5m']);
    const seconds = (Date.now() - started) / 1000;

    await finished;
    return seconds;
}

async function main() {
    const broken = process.argv.includes(BROKEN_FLAG);
    const profile = broken ? Profile.Broken : Profile.Hardened;

    // The run starts from a known shape, so what is measured is a release and not the
    // difference between whatever was deployed last time and this.
    await deploy(profile, BASE_REVISION);
    kubectl(['rollout', 'status', `deploy/${deployment}`, '--timeout=5m']);

    const directory = mkdtempSync(join(tmpdir(), 'marketplace-rollout-'));
    const codes = join(directory, 'codes.txt');

    try {
        const stop = startLoad(codes);
        const startedAt = Date.now();

        const seconds = await measuredRollout(profile, `run-${Date.now()}`);

        await delay(TAIL_MS);
        const elapsed = Date.now() - startedAt;

        if (elapsed < MIN_LOAD_MS) {
            await delay(MIN_LOAD_MS - elapsed);
        }

        await stop();

        const tally = tallyOf(codes);

        emit('profile', profile);
        emit('requests', tally.requests);
        emit('ok', tally.ok);
        emit('failed', tally.failed);
        emit('rollout-seconds', seconds.toFixed(2));

        if (broken) {
            // The control run: it is supposed to lose requests. Losing none would mean the
            // generator never crossed the window, and the zero above it would be luck.
            if (tally.failed === 0) {
                fail(
                    'The broken profile dropped nothing. That is not good news: it means the ' +
                        'load did not overlap the rollout, so the zero on the correct profile ' +
                        'is unproven. Raise the load or the warm-up and run it again.',
                );
            }
        } else if (tally.failed > 0) {
            fail(`${tally.failed} of ${tally.requests} responses were not ${OK}.`);
        } else if (tally.requests < 5_000) {
            fail(`${tally.requests} requests is too few to call zero a result.`);
        }
    } finally {
        rmSync(directory, { recursive: true, force: true });

        // Whatever happened, the cluster is left in the profile the other criteria read.
        if (broken) {
            await deploy(Profile.Hardened, BASE_REVISION);
            kubectl(['rollout', 'status', `deploy/${deployment}`, '--timeout=5m']);
        }
    }
}

main().catch((error) => {
    console.error(`\ndemo:rollout failed: ${error.message}\n`);
    process.exitCode = 2;
});
