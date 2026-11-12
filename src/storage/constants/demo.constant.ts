import { partCountFor, partSizeFor } from './storage.constant';

/**
 * The fixture the three demos share.
 *
 * Owned by one file so that a demo and the invariant it checks cannot disagree about what
 * was uploaded — the same reason `src/messaging/constants/demo.constant.ts` exists.
 */
export const DEMO_PREFIX = 'uploads/demo';

/**
 * Eleven MiB, and the number is chosen so the arithmetic is visible.
 *
 * At the computed part size — `max(5 MiB, ceil(11 MiB / 10 000))`, which is 5 MiB — this
 * is three parts: 5, 5 and 1. The last one is under the 5 MiB floor **and is allowed to
 * be**, because the minimum applies to every part except the last; a middle part that
 * small is how `CompleteMultipartUpload` comes back `EntityTooSmall`.
 */
export const DEMO_MULTIPART_BYTES = 11 * 1024 * 1024;

export const DEMO_PART_SIZE = partSizeFor(DEMO_MULTIPART_BYTES);
export const DEMO_PART_COUNT = partCountFor(DEMO_MULTIPART_BYTES);

/** Where the uploader is killed: after this many parts, before the third. */
export const DEMO_STOP_AFTER_PARTS = 2;

/** A small payload for the single-PUT demo. */
export const DEMO_SINGLE_BYTES = 64 * 1024;

/**
 * The name `demo:upload` sends, and the reason it sends it.
 *
 * It is a path traversal, which is what an object key composed from a client's filename
 * would turn into. `key-from-server=1` says it got nowhere near the key.
 */
export const DEMO_HOSTILE_FILENAME = '../../etc/passwd';

/** The asset `demo:cdn` publishes, in its two versions. */
export const DEMO_ASSET_NAME = 'app';
export const DEMO_ASSET_EXTENSION = 'css';
export const DEMO_ASSET_V1 = 'body{color:red}';
export const DEMO_ASSET_V2 = 'body{color:green}';

/**
 * Deterministic bytes of a given length.
 *
 * Both the parent and the child of `demo:multipart` build the payload from this, so the
 * child needs nothing on its command line but a part number — and so a part uploaded by
 * one process and a part uploaded by the other are the same bytes the complete object is
 * checked against.
 */
export function demoPayload(sizeBytes: number): Buffer {
    const buffer = Buffer.allocUnsafe(sizeBytes);

    for (let offset = 0; offset < sizeBytes; offset += 1) {
        buffer[offset] = offset % 251;
    }

    return buffer;
}
