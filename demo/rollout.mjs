import { spawn } from 'node:child_process';
import { createWriteStream, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emit, fail } from '../scripts/lib/emit.mjs';
import { delay, must, mustAsync } from '../scripts/lib/shell.mjs';
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

/**
 * How many requests are in flight at once. Thirty-two by default: enough to clear the
 * criterion's floor of five thousand inside one rollout, and nowhere near enough to be
 * the thing that breaks it.
 *
 * From the environment, because the right number is a property of the machine rather than
 * of this file — a smaller laptop, or a kind cluster sharing its CPU with everything else,
 * wants a gentler rate, and a generator that is itself the bottleneck measures itself.
 *
 *     LOAD_WORKERS=8 npm run demo:rollout
 */
const CONCURRENCY = workerCount(process.env.LOAD_WORKERS);
const PACE_MS = 20;
const REQUEST_TIMEOUT_MS = 5_000;

/**
 * The load keeps running for at least this long whatever the rollout does. A broken
 * rollout is over in a few seconds, and "zero failures out of nine hundred requests" is
 * not a result — the criterion's own floor is five thousand for the same reason.
 */
const MIN_LOAD_MS = positiveInteger('ROLLOUT_MIN_MS', process.env.ROLLOUT_MIN_MS, 20_000);

/**
 * How many responses it takes before "none of them failed" is a statement about the
 * rollout rather than about the sample. The criterion's own floor is five thousand and
 * that is the default; a runner with two cores hosting the cluster it is measuring is
 * slower than the laptop the number was chosen on, and the honest lever there is
 * `ROLLOUT_MIN_MS` — more seconds at the same rate — rather than fewer requests.
 */
const MIN_REQUESTS = positiveInteger(
    'ROLLOUT_MIN_REQUESTS',
    process.env.ROLLOUT_MIN_REQUESTS,
    5_000,
);

/** And a little after the rollout, because the last pod to go is the one that drops things. */
const TAIL_MS = 2_000;

/** A fixed revision to roll *from*, so every run measures the same kind of change. */
const BASE_REVISION = 'pre';

const NO_RESPONSE = '000';
const OK = '200';

const target = `http://127.0.0.1:${STACK.nodePort}/health`;
const deployment = 'marketplace-api';

/** What the rolling update itself cost, as opposed to the run that contains it. */
class RolloutMeasurement {
    constructor(seconds, during, failedDuring) {
        this.seconds = seconds;
        /** Responses that came back **while the rollout was in flight**. */
        this.during = during;
        this.failedDuring = failedDuring;
    }
}

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

/**
 * A tuning knob read from the environment, or its default.
 *
 * All three of these are properties of the **machine**, not of the thing being measured,
 * which is why none of them is a constant. A generator that is itself the bottleneck
 * measures itself; a floor calibrated on a laptop makes a two-core runner fail for being
 * a two-core runner. What must never move to make a run green is the claim — `failed` is
 * compared against zero here and nowhere else, and no variable can change that.
 */
function positiveInteger(name, raw, fallback) {
    const parsed = Number(raw ?? fallback);

    if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error(`${name}="${raw}" is not a positive integer`);
    }

    return parsed;
}

function workerCount(raw) {
    return positiveInteger('LOAD_WORKERS', raw, 32);
}

/**
 * Synchronous, and only where nothing else has to keep running.
 *
 * Every call made **while the load generator is working** goes through `kubectlAsync`
 * instead — see the comment on `measuredRollout`.
 */
function kubectl(args) {
    return must('kubectl', ['--context', KUBE_CONTEXT, '-n', STACK.namespace, ...args]);
}

function kubectlAsync(args) {
    return mustAsync('kubectl', ['--context', KUBE_CONTEXT, '-n', STACK.namespace, ...args]);
}

async function generation() {
    const raw = await kubectlAsync([
        'get',
        'deploy',
        deployment,
        '-o',
        'jsonpath={.metadata.generation}',
    ]);

    return Number(raw);
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

/**
 * The generator, plus a live count of what it has done.
 *
 * The counts are kept in memory as well as written to the file, and the two answer
 * different questions. The file is the record the final numbers are read back from — a
 * count computed from the thing that was written, not from a variable this script also
 * increments. The counters are sampled at the two edges of the rollout, which is the only
 * way to say how many responses arrived **during** it rather than around it.
 */
function startLoad(path) {
    const sink = createWriteStream(path, { flags: 'a' });
    const live = { requests: 0, failed: 0 };
    let running = true;

    const workers = Array.from({ length: CONCURRENCY }, async () => {
        while (running) {
            const code = await probe();

            live.requests += 1;

            if (code !== OK) {
                live.failed += 1;
            }

            sink.write(`${code}\n`);
            await delay(PACE_MS);
        }
    });

    return {
        live,
        stop: async () => {
            running = false;
            await Promise.all(workers);
            await new Promise((resolve) => sink.end(resolve));
        },
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
 * The rollout itself, timed from the moment the cluster is told about it — and measured
 * **while the generator is still generating**.
 *
 * `metadata.generation` moves when the spec changes, which is the first observable
 * instant of a release: earlier than "pulumi finished" and later than "pulumi started",
 * both of which would time this tool rather than the rolling update.
 *
 * ## Why every command in here is asynchronous
 *
 * `spawnSync` blocks the event loop until the child exits. `kubectl rollout status`
 * exits when the rollout is over, so a synchronous call freezes this process for exactly
 * the window being measured — the thirty-two workers above stop, their timers do not
 * fire, their sockets are not read, and every request they would have made during the
 * rolling update is simply never sent.
 *
 * The run still finished with thousands of requests and `failed=0`, because the load
 * before and after the window is real. The number was true and it proved nothing: a
 * release that drops every request in flight would have printed the same zero. Caught in
 * review, and the cure is both halves — the commands here are async, and
 * `during-rollout` is printed so that a zero overlap can never pass silently again.
 */
async function measuredRollout(profile, revision, live) {
    const before = await generation();
    const finished = deployAsync(profile, revision);

    while ((await generation()) === before) {
        await delay(100);
    }

    const started = Date.now();
    const atStart = { ...live };

    await kubectlAsync(['rollout', 'status', `deploy/${deployment}`, '--timeout=5m']);

    const seconds = (Date.now() - started) / 1000;
    const during = live.requests - atStart.requests;
    const failedDuring = live.failed - atStart.failed;

    await finished;
    return new RolloutMeasurement(seconds, during, failedDuring);
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
        const load = startLoad(codes);
        const startedAt = Date.now();

        const rollout = await measuredRollout(profile, `run-${Date.now()}`, load.live);

        await delay(TAIL_MS);
        const elapsed = Date.now() - startedAt;

        if (elapsed < MIN_LOAD_MS) {
            await delay(MIN_LOAD_MS - elapsed);
        }

        await load.stop();

        const tally = tallyOf(codes);

        emit('profile', profile);
        emit('requests', tally.requests);
        emit('ok', tally.ok);
        emit('failed', tally.failed);
        emit('rollout-seconds', rollout.seconds.toFixed(2));
        // The number that makes the one above it mean something: how many of those
        // responses came back **while** the new revision was replacing the old one.
        emit('during-rollout', rollout.during);
        emit('failed-during-rollout', rollout.failedDuring);
        emit('workers', CONCURRENCY);

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
        } else if (tally.requests < MIN_REQUESTS) {
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
