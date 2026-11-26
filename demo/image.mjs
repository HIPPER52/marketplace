import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { emit, fail } from '../scripts/lib/emit.mjs';
import { must, run } from '../scripts/lib/shell.mjs';
import { IMAGE_REF, REPO_ROOT } from '../scripts/lib/stack.mjs';

/**
 * What the production image is, and what is not inside it.
 *
 *   npm run demo:image
 *
 * Six numbers, all of them read out of the built image rather than out of the Dockerfile
 * — with one deliberate exception, the stage count, which is a property of the recipe and
 * of nothing else. `shell-inside` in particular is answered by trying to run a shell: a
 * base image inherited from somebody else can grow one without anybody here deciding to,
 * and reading the FROM line would never notice.
 *
 * The three token counts are three searches because no single tool sees both leaks.
 * `docker history` finds a value substituted into a command and is blind to a file in a
 * layer; unpacking the layers is the other way round. Hence three places, and hence the
 * control image below, which leaks into two of them on purpose.
 */

const LEAK_IMAGE = 'marketplace-leak:demo';
const LEAK_DOCKERFILE = 'docker/leak.Dockerfile';
const DOCKERFILE = 'docker/Dockerfile';
const TOKEN_FILE = '.npm_token';

/** Named: both the real image and the control one are measured into this shape. */
class LeakReport {
    constructor(history, config, layers) {
        this.history = history;
        this.config = config;
        this.layers = layers;
    }

    get total() {
        return this.history + this.config + this.layers;
    }
}

function occurrences(haystack, needle) {
    let count = 0;
    let index = haystack.indexOf(needle);

    while (index !== -1) {
        count += 1;
        index = haystack.indexOf(needle, index + needle.length);
    }

    return count;
}

/**
 * Every regular file under a directory, however deep.
 *
 * `docker save` writes an OCI layout: a flat blobs/sha256/ directory holding both the
 * JSON documents that describe the image and the layer archives themselves.
 */
function filesUnder(directory) {
    const found = [];

    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);

        if (entry.isDirectory()) {
            found.push(...filesUnder(path));
        } else if (entry.isFile() && statSync(path).size > 0) {
            found.push(path);
        }
    }

    return found;
}

const GZIP_MAGIC = Buffer.from([0x1f, 0x8b]);

/**
 * The trap this function exists for.
 *
 * Layer blobs in a saved image are **gzip**, so `grep -r` over the unpacked archive finds
 * nothing and reports a clean image — the most dangerous answer a security check can give,
 * because it is indistinguishable from the true one. Every blob is therefore decompressed
 * before it is searched, and the JSON documents are counted as config rather than as
 * layers so that the two channels stay separate in the output.
 */
function searchArchive(image, token) {
    const directory = mkdtempSync(join(tmpdir(), 'marketplace-image-'));
    const archive = join(directory, 'image.tar');
    let config = 0;
    let layers = 0;

    try {
        must('docker', ['save', '--output', archive, image]);
        must('tar', ['-xf', archive, '-C', directory]);
        rmSync(archive);

        for (const path of filesUnder(directory)) {
            const raw = readFileSync(path);

            if (raw.subarray(0, 2).equals(GZIP_MAGIC)) {
                layers += occurrences(gunzipSync(raw), Buffer.from(token));
                continue;
            }

            // The manifest, the index and the image config — the config blob is where an
            // ARG that was substituted into a RUN line comes to rest.
            config += occurrences(raw, Buffer.from(token));
        }
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }

    return { config, layers };
}

function measure(image, token) {
    const history = occurrences(
        must('docker', ['history', '--no-trunc', '--format', '{{json .}}', image]),
        token,
    );
    const inspected = occurrences(must('docker', ['image', 'inspect', image]), token);
    const archive = searchArchive(image, token);

    return new LeakReport(history, inspected + archive.config, archive.layers);
}

function main() {
    const token = readFileSync(join(REPO_ROOT, TOKEN_FILE), 'utf8').trim();

    if (token.length === 0) {
        throw new Error(`${TOKEN_FILE} is empty. Run: npm run image:build`);
    }

    if (run('docker', ['image', 'inspect', IMAGE_REF]).code !== 0) {
        throw new Error(`${IMAGE_REF} is not on this machine. Run: npm run image:build`);
    }

    const dockerfile = readFileSync(join(REPO_ROOT, DOCKERFILE), 'utf8');
    const stages = (dockerfile.match(/^FROM /gm) ?? []).length;

    // Asked of the image, not of the recipe: `docker run --entrypoint sh` either finds a
    // shell or does not, whatever any FROM line suggests.
    const shell = run('docker', ['run', '--rm', '--entrypoint', 'sh', IMAGE_REF, '-c', 'echo x']);
    const user = must('docker', ['image', 'inspect', '--format', '{{.Config.User}}', IMAGE_REF]);
    const real = measure(IMAGE_REF, token);

    emit('stages', stages);
    emit('shell-inside', shell.code === 0 ? 1 : 0);
    emit('runtime-uid', user.trim());
    emit('token-in-history', real.history);
    emit('token-in-config', real.config);
    emit('token-in-layers', real.layers);

    // The control run. Same token, same three searches, a Dockerfile that passes it the
    // careless way — if this comes back clean the searches are broken, not the image.
    must('docker', [
        'build',
        '--file',
        LEAK_DOCKERFILE,
        '--provenance=false',
        '--build-arg',
        `NPM_TOKEN=${token}`,
        '--tag',
        LEAK_IMAGE,
        REPO_ROOT,
    ]);

    try {
        const leaked = measure(LEAK_IMAGE, token);

        emit('leak-token-in-history', leaked.history);
        emit('leak-token-in-config', leaked.config);
        emit('leak-token-in-layers', leaked.layers);

        if (leaked.total === 0) {
            fail(
                'The control image leaks the token by construction and the search found ' +
                    'none of it. The three zeros above are therefore worth nothing — fix ' +
                    'the search before trusting them.',
            );
        }
    } finally {
        run('docker', ['image', 'rm', '--force', LEAK_IMAGE]);
    }

    if (stages < 2) {
        fail(`stages=${stages}: a single-stage image ships whatever it was built with.`);
    }

    if (shell.code === 0) {
        fail(
            'shell-inside=1: there is a shell in the final image, so `sh -c` has something to run.',
        );
    }

    if (user.trim() === '' || user.trim() === '0' || user.trim() === 'root') {
        fail(`runtime-uid=${user.trim() || '(empty)'}: the process runs as root.`);
    }

    if (real.total > 0) {
        fail(`the build-stage token is in the image: ${JSON.stringify(real)}`);
    }
}

try {
    main();
} catch (error) {
    console.error(`\ndemo:image failed: ${error.message}\n`);
    process.exitCode = 2;
}
