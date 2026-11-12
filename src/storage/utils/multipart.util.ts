import type { UploadedPart } from '../types/storage.types';

/**
 * PUTs one part to a presigned URL and returns its ETag.
 *
 * Plain `fetch`, no SDK and no credentials: this is what a browser would do, and the
 * child process in `demo:multipart` runs with an environment that has no keys in it at
 * all. The ETag comes back in a header and is what `CompleteMultipartUpload` is given.
 */
export async function putSignedPart(
    url: string,
    body: Buffer,
    partNumber: number,
): Promise<UploadedPart> {
    const response = await fetch(url, {
        method: 'PUT',
        body: new Uint8Array(body),
        headers: { 'content-length': String(body.length) },
    });

    if (!response.ok) {
        throw new Error(`part ${partNumber} was refused with ${response.status}`);
    }

    const eTag = response.headers.get('etag');

    if (eTag === null) {
        throw new Error(`part ${partNumber} came back without an ETag`);
    }

    return { partNumber, eTag };
}

/**
 * The slice of the payload a part number covers.
 *
 * The last one is short, and that is the only part S3 lets be under 5 MiB.
 */
export function sliceFor(body: Buffer, partNumber: number, partSize: number): Buffer {
    const start = (partNumber - 1) * partSize;

    return body.subarray(start, Math.min(start + partSize, body.length));
}

/**
 * What is left to upload — **the question that makes this a recovery protocol**.
 *
 * `present` comes from `ListParts`, which is to say from the store rather than from any
 * memory the dead process had. Skip this and a resumed upload sends everything again,
 * which is what "supports large files" means when nobody measured it.
 */
export function missingParts(present: UploadedPart[], totalParts: number): number[] {
    const have = new Set(present.map((part) => part.partNumber));

    return Array.from({ length: totalParts }, (_unused, index) => index + 1).filter(
        (partNumber) => !have.has(partNumber),
    );
}
