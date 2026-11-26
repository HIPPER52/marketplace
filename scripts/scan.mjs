import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emit } from './lib/emit.mjs';
import { must, run } from './lib/shell.mjs';
import { IMAGE_REF } from './lib/stack.mjs';

/**
 * Scans the production image and compares the count against a threshold.
 *
 *   npm run scan                 # the working threshold below
 *   SCAN_MAX=0 npm run scan      # anything at all is a failure
 *
 * The verdict is **computed**, and that is the whole of it. A script that prints
 * `gate=pass` is not a gate; this one counts the findings in the report and compares, so
 * the same command with a different threshold gives a different answer and a different
 * exit code. Without a threshold a scanner makes CI red for ever, and a build that is
 * always red is a build nobody reads.
 *
 * `--ignore-unfixed` is why a small number is honest: it drops everything with no fix
 * available, so what remains is work somebody could actually do. The count is not a
 * measure of how good the image is — the lecture measured distroless at 41 findings
 * against alpine's 16 and the distroless image is not the leakier one. Different base
 * distributions have different advisory feeds. What distroless buys is on the other
 * slide: no shell to execute and no root to execute it as.
 */

/**
 * The working threshold: a ratchet, not an opinion.
 *
 * Measured at **19 on 18.11.2026** — seven in the distroless base (all of them openssl,
 * fixed by a newer base image and by nothing this repository can do) and twelve in
 * transitive npm dependencies, none of them a direct one: body-parser and proxy-addr
 * arrive with express 4, which is pinned at 4.22.2 for a documented behavioural reason,
 * and multer arrives with @nestjs/platform-express.
 *
 * The number is here so that the gate means "no **new** fixable CRITICAL or HIGH", which
 * is a thing a team can actually hold itself to. Zero would be the honest-looking choice
 * and the useless one: the build would be red from the first run, and a build that is
 * always red is a build nobody reads — which is the lecture's point about thresholds and
 * not a loophole in it. It may be lowered. Raising it needs a date and a sentence beside
 * it, in this comment, saying what was accepted and why.
 *
 * The scanner's database is refreshed daily, so this going red one morning is the
 * mechanism working rather than failing.
 */
const DEFAULT_MAX = 19;

const SEVERITIES = ['CRITICAL', 'HIGH'];

/**
 * Pinned, like everything else here. A scanner is not a library but its output shape is
 * an interface, and `latest` means the day the JSON changes is a day this script breaks
 * for reasons that have nothing to do with the image.
 */
const TRIVY_IMAGE = 'aquasec/trivy:0.76.2';
const TRIVY_CACHE_VOLUME = 'marketplace-trivy-cache';

/** The signature of a half-written bbolt database, which no retry on its own survives. */
const CORRUPT_CACHE = /assertion failed|bbolt|panic:/;

function scanWith(directory) {
    return run('docker', [
        'run',
        '--rm',
        '--volume',
        `${TRIVY_CACHE_VOLUME}:/root/.cache`,
        '--volume',
        `${directory}:/scan:ro`,
        TRIVY_IMAGE,
        'image',
        '--input',
        '/scan/image.tar',
        '--scanners',
        'vuln',
        '--severity',
        SEVERITIES.join(','),
        '--ignore-unfixed',
        '--format',
        'json',
        '--quiet',
    ]);
}

function thresholdFrom(raw) {
    if (raw === undefined || raw.trim() === '') {
        return DEFAULT_MAX;
    }

    const parsed = Number(raw);

    if (!Number.isInteger(parsed)) {
        throw new Error(`SCAN_MAX="${raw}" is not an integer`);
    }

    return parsed;
}

function countFindings(report) {
    const results = Array.isArray(report.Results) ? report.Results : [];

    return results.reduce(
        (total, result) =>
            total + (Array.isArray(result.Vulnerabilities) ? result.Vulnerabilities.length : 0),
        0,
    );
}

function main() {
    const max = thresholdFrom(process.env.SCAN_MAX);

    if (run('docker', ['image', 'inspect', IMAGE_REF]).code !== 0) {
        throw new Error(`${IMAGE_REF} is not on this machine. Run: npm run image:build`);
    }

    // The image goes to the scanner as a tar rather than through a mounted Docker socket.
    // Handing a container the socket is handing it the daemon, and a vulnerability scanner
    // is exactly the kind of tool that should not need that to do its job.
    const directory = mkdtempSync(join(tmpdir(), 'marketplace-scan-'));
    const archive = join(directory, 'image.tar');

    try {
        must('docker', ['save', '--output', archive, IMAGE_REF]);

        let scan = scanWith(directory);

        /**
         * A cache that cannot be read is a cache to throw away, not a gate to fail.
         *
         * trivy keeps its vulnerability database in a bbolt file, and a write interrupted
         * by a full disk leaves it corrupt — after which every run panics with "assertion
         * failed: Page expected to be" and a Go stack trace, for ever. Measured here, the
         * hard way. The volume is named rather than anonymous precisely so that throwing
         * it away is one line; the cost of being wrong is one database download.
         */
        if (scan.code !== 0 && CORRUPT_CACHE.test(scan.output)) {
            console.error('the scanner cache is corrupt; dropping it and scanning again');
            run('docker', ['volume', 'rm', '--force', TRIVY_CACHE_VOLUME]);
            scan = scanWith(directory);
        }

        if (scan.code !== 0) {
            throw new Error(`trivy exited ${scan.code}\n${scan.output.trim()}`);
        }

        const found = countFindings(JSON.parse(scan.stdout));
        const passed = found <= max;

        emit('image', IMAGE_REF);
        emit('severity', SEVERITIES.join('+'));
        emit('found', found);
        emit('max-allowed', max);
        emit('gate', passed ? 'pass' : 'fail');

        if (!passed) {
            process.exitCode = 1;
        }
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
}

try {
    main();
} catch (error) {
    console.error(`\nscan failed: ${error.message}\n`);
    process.exitCode = 2;
}
