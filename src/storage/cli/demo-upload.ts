import 'reflect-metadata';
import { fork } from 'node:child_process';
import { join } from 'node:path';
import { call, type DemoApp, openDemoApp } from '../../auth/utils/demo-app.util';
import type { TokenPairResponse, UploadIntent } from '../../common/types/api.types';
import { emit, finish, sleep } from '../../common/utils/demo-report.util';
import { isPortAlive } from '../../common/utils/port.util';
import { DEMO_BUYER_EMAIL, DEMO_PASSWORD } from '../../users/constants/demo-accounts.constant';
import { seedDemoAccounts } from '../../users/utils/demo-account.util';
import { DEMO_HOSTILE_FILENAME, DEMO_SINGLE_BYTES, demoPayload } from '../constants/demo.constant';
import { openDemoStand } from '../utils/demo-stand.util';

/** A grant that is already stale by the time it is used. */
const EXPIRED_AFTER_SEC = 3;
const WAIT_PAST_EXPIRY_MS = 4_500;

/**
 * The bytes go **past** this service, and the service still knows what happened.
 *
 *   npm run demo:upload
 *
 * The half this is easy to be mistaken for: "there is an upload endpoint" is also true of
 * something that proxies every byte through the API. So the proof is arranged to be
 * impossible for a proxy to produce — **the application is switched off before a single
 * byte moves**, and the PUT is made by a separate process whose environment holds no key
 * of any kind. `api-alive=0` beside `put-offline=200` is the whole first claim; a proxy
 * prints `put-offline=0`.
 *
 * Four more properties of a presigned URL, each one line:
 *
 * - **the key is the server's.** The intent is sent a path traversal as a filename and
 *   `key-from-server=1` says none of it arrived.
 * - **commit is honest.** A reservation nobody uploaded to cannot be committed, because
 *   commit asks the store rather than the client — `commit-without-bytes` is a 4xx.
 * - **the signature covers the path.** Swap the key in the URL and the store answers 403.
 * - **and the clock.** The same URL, a few seconds late, is 403 as well.
 */
async function main(): Promise<void> {
    const stand = await openDemoStand();
    let app: DemoApp | null = null;

    try {
        await seedDemoAccounts(stand.dataSource);
        await stand.reset();

        // ---- the service is up, and hands out grants ----------------------------------
        app = await openDemoApp();
        const firstPort = portOf(app.baseUrl);
        const token = await signIn(app);

        const intent = await call<UploadIntent>(app, 'POST', '/uploads/intent', {
            token,
            body: {
                content_type: 'image/png',
                size_bytes: DEMO_SINGLE_BYTES,
                // A path traversal, on purpose. If any of it reaches the key, a client
                // has been handed the right to write anywhere in the bucket.
                filename: DEMO_HOSTILE_FILENAME,
            },
        });

        const objectKey = intent.body?.object_key ?? '';
        const grant = intent.body?.url ?? '';

        console.log(`intent -> ${intent.status}`);
        console.log(`  filename sent: ${DEMO_HOSTILE_FILENAME}`);
        console.log(`  key composed:  ${objectKey}`);

        // A second reservation nobody will upload to, and a grant that expires while we
        // watch. Both are taken now, because the service is about to be stopped.
        const unused = await call<UploadIntent>(app, 'POST', '/uploads/intent', {
            token,
            body: { content_type: 'image/png', size_bytes: DEMO_SINGLE_BYTES },
        });

        const shortLived = await stand.presigner.put(
            `${objectKey}.expired`,
            'image/png',
            EXPIRED_AFTER_SEC,
        );

        // ---- switch the service off ------------------------------------------------------
        await app.close();
        app = null;

        const alive = await isPortAlive(firstPort);

        console.log(`\nthe application is stopped: port ${firstPort} alive = ${String(alive)}`);

        const offline = await putFromNowhere(grant, 'image/png', DEMO_SINGLE_BYTES);

        console.log(`PUT from a process with no credentials -> ${offline}`);

        // ---- back up, on a different port -------------------------------------------------
        // A different one because Node's global fetch pools connections by (host, port):
        // reusing the number can hand this process a dead socket from the pool.
        app = await openDemoApp();
        const freshToken = await signIn(app);

        const commit = await call(app, 'POST', '/uploads/commit', {
            token: freshToken,
            body: { file_id: intent.body?.file_id },
        });

        const empty = await call(app, 'POST', '/uploads/commit', {
            token: freshToken,
            body: { file_id: unused.body?.file_id },
        });

        console.log(`\ncommit of what was uploaded     -> ${commit.status}`);
        console.log(`commit of what was not          -> ${empty.status}`);

        // ---- the signature covers the path, and the clock ----------------------------------
        const tampered = await putRaw(swapKey(grant, objectKey), 'image/png', DEMO_SINGLE_BYTES);

        await sleep(WAIT_PAST_EXPIRY_MS);

        const expired = await putRaw(shortLived, 'image/png', DEMO_SINGLE_BYTES);

        console.log(`\nkey swapped inside the URL      -> ${tampered}`);
        console.log(
            `a ${EXPIRED_AFTER_SEC} s grant used after ${WAIT_PAST_EXPIRY_MS} ms -> ${expired}`,
        );

        emit({
            intent: intent.status,
            'key-from-server': Number(keyIsOurs(objectKey)),
            'api-alive': Number(alive),
            'put-offline': offline,
            commit: commit.status,
            'commit-without-bytes': empty.status,
            tampered,
            expired,
        });

        const failures: string[] = [];

        if (intent.status !== 200 || grant === '') {
            failures.push(`the intent answered ${intent.status} and no grant`);
        }

        if (!keyIsOurs(objectKey)) {
            failures.push(
                `the client's filename reached the key (${objectKey}): the bucket is writable ` +
                    'at a path the client chose',
            );
        }

        if (alive) {
            failures.push(
                `port ${firstPort} still answers, so the next line proves nothing about who ` +
                    'carried the bytes',
            );
        }

        if (offline !== 200) {
            failures.push(
                `the PUT answered ${offline} with the application switched off — a solution ` +
                    'that proxies the file through the backend gives exactly this',
            );
        }

        if (commit.status !== 200) {
            failures.push(`commit of a real upload answered ${commit.status}`);
        }

        if (empty.status < 400 || empty.status >= 500) {
            failures.push(
                `committing an upload that never happened answered ${empty.status}; without a ` +
                    'HeadObject it answers 200 and the row points at nothing',
            );
        }

        if (tampered !== 403) {
            failures.push(`a URL with the key swapped answered ${tampered}, not 403`);
        }

        if (expired !== 403) {
            failures.push(`an expired grant answered ${expired}, not 403`);
        }

        finish(
            failures,
            'the bytes reached the store while this service was switched off, under a key the\n' +
                'service composed; a commit over nothing was refused; and the grant stopped\n' +
                'working both when its path was edited and when its few seconds ran out.',
        );
    } finally {
        await app?.close();
        await stand.reset().catch(() => undefined);
        await stand.shutdown();
    }
}

async function signIn(app: DemoApp): Promise<string> {
    const login = await call<TokenPairResponse>(app, 'POST', '/auth/login', {
        body: { email: DEMO_BUYER_EMAIL, password: DEMO_PASSWORD },
    });

    if (login.status !== 200) {
        throw new Error(`could not sign in: ${login.status}`);
    }

    return login.body.access_token;
}

/** The PUT, from a forked process holding nothing but the URL. */
function putFromNowhere(url: string, contentType: string, sizeBytes: number): Promise<number> {
    const child = fork(
        join(__dirname, 'put-child.js'),
        [JSON.stringify({ url, contentType, sizeBytes })],
        {
            env: { PATH: process.env.PATH ?? '' },
        },
    );

    return new Promise((resolve, reject) => {
        child.once('message', (message: { status: number }) => resolve(message.status));
        child.once('exit', (code) => {
            if (code !== 0) {
                reject(new Error(`the uploader exited with ${code}`));
            }
        });
    });
}

/** The same request, made here, for the two cases that are meant to be refused. */
async function putRaw(url: string, contentType: string, sizeBytes: number): Promise<number> {
    const response = await fetch(url, {
        method: 'PUT',
        headers: { 'content-type': contentType },
        body: new Uint8Array(demoPayload(sizeBytes)),
    });

    return response.status;
}

/** Edits the object key inside a signed URL, leaving the signature alone. */
function swapKey(url: string, objectKey: string): string {
    return url.replace(objectKey, objectKey.replace(/[^/]+$/, 'somebody-elses.png'));
}

/** The port `openDemoApp` happened to be given. */
function portOf(baseUrl: string): number {
    return Number(new URL(baseUrl).port);
}

/** Whether anything the client sent survived into the key. */
function keyIsOurs(objectKey: string): boolean {
    return (
        objectKey !== '' &&
        !objectKey.includes('..') &&
        !objectKey.includes('passwd') &&
        !objectKey.includes('etc/')
    );
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exit(1);
});
