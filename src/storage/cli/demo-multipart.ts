import 'reflect-metadata';
import { fork } from 'node:child_process';
import { join } from 'node:path';
import { emit, finish } from '../../common/utils/demo-report.util';
import { DEMO_BUYER_ID } from '../../users/constants/demo-accounts.constant';
import {
    DEMO_MULTIPART_BYTES,
    DEMO_PART_COUNT,
    DEMO_PART_SIZE,
    DEMO_STOP_AFTER_PARTS,
    demoPayload,
} from '../constants/demo.constant';
import { MAX_PARTS, MIN_PART_BYTES } from '../constants/storage.constant';
import type { GrantedPart } from '../types/upload.types';
import { UploadMode } from '../types/upload.types';
import { openDemoStand } from '../utils/demo-stand.util';
import { missingParts, putSignedPart, sliceFor } from '../utils/multipart.util';

/**
 * Multipart is a **recovery protocol**, not a trick for big files.
 *
 *   npm run demo:multipart
 *
 * The half this is easy to be mistaken for: "we support large uploads" is equally true of
 * something that starts again from zero after a dropped connection. Here a process dies
 * after two parts of three, a *different* process asks the store what is already there,
 * and exactly one part is sent. `resumed-parts=1` is the whole demo; a solution without
 * `ListParts` prints 3 and is a different program.
 *
 * Two more things fall out of it and are printed:
 *
 * - **before `CompleteMultipartUpload` there is no object.** The parts are stored and
 *   billed, `ListParts` sees them, and `HeadObject` answers 404. Complete is an atomic
 *   switch, not a flush.
 * - **the ETag of a multipart object is not an MD5.** The `-3` suffix is the number of
 *   parts, which is why code that compares an ETag against a local checksum breaks here
 *   quietly.
 *
 * The run cleans up before it starts *and* after it finishes, because the acceptance
 * criterion runs it twice in a row: a demo that left its object behind would see
 * `head-before-complete=200` the second time and would be right to fail.
 */
async function main(): Promise<void> {
    const stand = await openDemoStand();

    try {
        await stand.reset();

        console.log(
            `${DEMO_MULTIPART_BYTES} B at a computed part size of ${DEMO_PART_SIZE} B ` +
                `-> ${DEMO_PART_COUNT} parts ` +
                `(floor ${MIN_PART_BYTES} B, ceiling ${MAX_PARTS} parts)`,
        );

        const granted = await stand.uploads.intent({
            ownerId: DEMO_BUYER_ID,
            contentType: 'application/pdf',
            sizeBytes: DEMO_MULTIPART_BYTES,
        });

        if (granted.mode !== UploadMode.Multipart) {
            throw new Error('the threshold put this below multipart; the demo has no subject');
        }

        const key = granted.file.objectKey;

        // ---- a process that dies two parts in -------------------------------------------
        await uploadAndDie(granted.parts);

        const held = await stand.store.listParts(key, granted.uploadId);
        const beforeComplete = await stand.store.head(key);

        console.log(
            `\n[ListParts]  ${held.map((part) => `#${part.partNumber}`).join(' ')} ` +
                `(${held.length} of ${DEMO_PART_COUNT})`,
        );
        console.log(`[HeadObject] ${beforeComplete === null ? 'NotFound' : 'found'}`);

        // ---- a different process tops up what is missing ----------------------------------
        const remaining = missingParts(held, DEMO_PART_COUNT);
        const body = demoPayload(DEMO_MULTIPART_BYTES);

        for (const partNumber of remaining) {
            const part = granted.parts.find((candidate) => candidate.partNumber === partNumber);

            if (part === undefined) {
                throw new Error(`no grant was issued for part ${partNumber}`);
            }

            await putSignedPart(part.url, sliceFor(body, partNumber, DEMO_PART_SIZE), partNumber);
        }

        console.log(`[resume]     topped up ${remaining.length} part(s): ${remaining.join(', ')}`);

        // ---- commit, which is where ListParts and Complete happen for real -----------------
        const committed = await stand.uploads.commit(granted.file.id, DEMO_BUYER_ID);
        const head = await stand.store.head(key);
        const eTag = head?.eTag ?? '';

        console.log(`[complete]   ${head?.sizeBytes} B, ETag ${eTag}`);

        emit({
            'head-before-complete': beforeComplete === null ? 404 : 200,
            'resumed-parts': remaining.length,
            complete: committed.status === 'completed' ? 200 : 0,
            'size-match': Number(head?.sizeBytes === DEMO_MULTIPART_BYTES),
            'etag-multipart': Number(new RegExp(`-${DEMO_PART_COUNT}"?$`).test(eTag)),
            'part-size': DEMO_PART_SIZE,
            parts: DEMO_PART_COUNT,
        });

        const failures: string[] = [];

        if (beforeComplete !== null) {
            failures.push(
                'HeadObject found an object before Complete — either the previous run left one ' +
                    'behind, or the parts are being written as an object, which they are not',
            );
        }

        if (remaining.length !== DEMO_PART_COUNT - DEMO_STOP_AFTER_PARTS) {
            failures.push(
                `the resume sent ${remaining.length} parts where ${
                    DEMO_PART_COUNT - DEMO_STOP_AFTER_PARTS
                } were missing: ListParts was not asked, or was not believed`,
            );
        }

        if (committed.status !== 'completed') {
            failures.push(`commit left the row ${committed.status}`);
        }

        if (head?.sizeBytes !== DEMO_MULTIPART_BYTES) {
            failures.push(
                `the assembled object is ${head?.sizeBytes} B against ${DEMO_MULTIPART_BYTES} B uploaded`,
            );
        }

        if (!new RegExp(`-${DEMO_PART_COUNT}"?$`).test(eTag)) {
            failures.push(`ETag ${eTag} does not end in -${DEMO_PART_COUNT}`);
        }

        finish(
            failures,
            `a process died after ${DEMO_STOP_AFTER_PARTS} of ${DEMO_PART_COUNT} parts and another ` +
                'sent exactly the one that\nwas missing. Until Complete there was no object, only ' +
                'parts somebody was\nalready paying for — and the ETag counts them rather than hashing them.',
        );
    } finally {
        await stand.reset().catch(() => undefined);
        await stand.shutdown();
    }
}

/** Spawns the uploader with no credentials and waits for it to be killed. */
function uploadAndDie(parts: GrantedPart[]): Promise<void> {
    const plan = JSON.stringify({
        parts,
        partSize: DEMO_PART_SIZE,
        totalBytes: DEMO_MULTIPART_BYTES,
        stopAfter: DEMO_STOP_AFTER_PARTS,
    });

    const child = fork(join(__dirname, 'multipart-child.js'), [plan], {
        // Nothing it could sign with. The URLs in the plan are the entire grant.
        env: { PATH: process.env.PATH ?? '' },
    });

    return new Promise((resolve, reject) => {
        child.once('exit', (code, signal) => {
            if (signal === 'SIGKILL') {
                resolve();
                return;
            }

            reject(new Error(`the uploader exited with code ${code} / signal ${signal}`));
        });
    });
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exit(1);
});
