import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { delay } from '../../scripts/lib/shell.mjs';
import { REPO_ROOT } from '../../scripts/lib/stack.mjs';

/**
 * Starts the service as a child process and keeps every line it writes.
 *
 * The lines are the measurement, so they are kept raw as well as parsed: `non-json-lines`
 * is a count of what did **not** parse, and a harness that only kept the parsed ones
 * could never report it.
 */

const READY_MESSAGE = 'demo app listening';
const START_TIMEOUT_MS = 90_000;

/** Named: three demos destructure it and one of them passes it around. */
export class AppUnderTest {
    constructor(child, baseUrl, lines) {
        this.child = child;
        this.baseUrl = baseUrl;
        /** Every line of stdout, in order, exactly as it was written. */
        this.lines = lines;
    }

    /** The lines that parsed as JSON, which is all of them when the service is correct. */
    get records() {
        return this.lines.flatMap((line) => {
            try {
                return [JSON.parse(line)];
            } catch {
                return [];
            }
        });
    }

    get nonJsonLines() {
        return this.lines.length - this.records.length;
    }

    /**
     * A cursor into the log, so a phase can read only its own lines.
     *
     * A cursor rather than clearing the array: `non-json-lines` is a statement about the
     * **whole** run, and a demo that threw away the start of the log could not make it.
     */
    mark() {
        return this.lines.length;
    }

    /** The parsed lines written since a mark, dropping any that were not JSON. */
    recordsSince(mark) {
        return this.lines.slice(mark).flatMap((line) => {
            try {
                return [JSON.parse(line)];
            } catch {
                return [];
            }
        });
    }

    /**
     * Waits for the **last** line of a request rather than the first.
     *
     * The access line is written when the response finishes, which is a tick after the
     * client already has its answer — so a demo that starts counting the moment `fetch`
     * resolves files that line under the next phase and reports a group of one. Measured:
     * it cost a run that read `burst-trace-ids=9` for eight requests.
     */
    async waitForRequest(traceId, timeoutMs = 15_000) {
        const deadline = Date.now() + timeoutMs;

        while (Date.now() < deadline) {
            const done = this.records.some(
                (record) => record.trace_id === traceId && record.layer === 'http.access',
            );

            if (done) {
                return true;
            }

            await delay(25);
        }

        return false;
    }

    async flushSpans() {
        await fetch(`${this.baseUrl}/demo/flush`).catch(() => undefined);
    }

    async stop() {
        this.child.kill('SIGTERM');
        await new Promise((resolve) => this.child.once('close', resolve));
    }
}

export async function startApp(env = {}) {
    const child = spawn('node', [join(REPO_ROOT, 'demo', 'children', 'app-child.mjs')], {
        cwd: REPO_ROOT,
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    const lines = [];
    let baseUrl;

    // Line by line rather than chunk by chunk: a pino line can be split across two reads,
    // and half a JSON document counted as a non-JSON line is a measurement of the reader.
    createInterface({ input: child.stdout }).on('line', (line) => {
        if (line.length === 0) {
            return;
        }

        lines.push(line);

        try {
            const record = JSON.parse(line);

            if (record.msg === READY_MESSAGE) {
                baseUrl = record.base_url;
            }
        } catch {
            // Kept in `lines` and counted there; nothing else to do with it here.
        }
    });

    // stderr is a different stream and is not part of the log. A stack trace there is
    // worth seeing while a demo is being written, and worth separating from the count.
    createInterface({ input: child.stderr }).on('line', (line) => {
        process.stderr.write(`[child] ${line}\n`);
    });

    const deadline = Date.now() + START_TIMEOUT_MS;

    while (baseUrl === undefined) {
        if (child.exitCode !== null) {
            throw new Error(`the service exited with ${child.exitCode} before it listened`);
        }

        if (Date.now() > deadline) {
            throw new Error('the service did not start within 90 s');
        }

        await delay(100);
    }

    return new AppUnderTest(child, baseUrl, lines);
}

/** A W3C `traceparent` the demo generates, so it knows the id it is looking for. */
export function newTraceparent() {
    const traceId = randomHex(32);
    const spanId = randomHex(16);

    return { traceId, spanId, header: `00-${traceId}-${spanId}-01` };
}

function randomHex(length) {
    let out = '';

    while (out.length < length) {
        out += Math.floor(Math.random() * 16).toString(16);
    }

    return out;
}
