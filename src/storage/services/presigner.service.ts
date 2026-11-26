import {
    GetObjectCommand,
    PutObjectCommand,
    S3Client,
    UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable } from '@nestjs/common';
import { GET_EXPIRES_SEC, PUT_EXPIRES_SEC } from '../constants/storage.constant';
import { STORAGE_BUCKET, STORAGE_CLIENT } from '../constants/storage.tokens';

/**
 * Delegating the right to write one object, for a while.
 *
 * ## What a presigned URL is, and what it is not
 *
 * It is a **bearer token** — AWS's own wording: "presigned URLs are bearer tokens that
 * grant access to those who possess them". It is not a JWT: no `jti`, no claims, no JWKS,
 * and the party that verifies it is the store rather than this service. Everything that
 * follows comes from those two facts.
 *
 * It is **not single-use**. The same string works as many times as you like until it
 * expires, which is exactly why a leak is expensive and why the expiry is a decision —
 * see `PUT_EXPIRES_SEC`.
 *
 * It **cannot be revoked**. There is nothing to put on a denylist, nobody to ask, and no
 * registry to mark. Of the four strategies #24 built, only one transfers: make the window
 * short enough that revocation is not needed, and hand out a fresh URL per request
 * through `GET /files/{id}` instead of a long-lived one by mail.
 *
 * ## What the signature covers
 *
 * The method, the host, the path and the signed headers — so swapping the key in a URL
 * invalidates it (`demo:upload` prints `tampered=403`), and so does arriving a second
 * late. It does **not** cover the body: the signature says where you may write and for
 * how long, never what you may put there. `Content-Type` is signed deliberately, which
 * narrows the grant further and is why the uploader must send exactly the type it asked
 * for.
 */
@Injectable()
export class Presigner {
    constructor(
        @Inject(STORAGE_CLIENT) private readonly client: S3Client,
        @Inject(STORAGE_BUCKET) private readonly bucket: string,
    ) {}

    put(key: string, contentType: string, expiresIn: number = PUT_EXPIRES_SEC): Promise<string> {
        return getSignedUrl(
            this.client,
            new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType }),
            { expiresIn },
        );
    }

    /** One part of a multipart upload. The part number is signed with everything else. */
    uploadPart(
        key: string,
        uploadId: string,
        partNumber: number,
        expiresIn: number = PUT_EXPIRES_SEC,
    ): Promise<string> {
        return getSignedUrl(
            this.client,
            new UploadPartCommand({
                Bucket: this.bucket,
                Key: key,
                UploadId: uploadId,
                PartNumber: partNumber,
            }),
            { expiresIn },
        );
    }

    get(key: string, expiresIn: number = GET_EXPIRES_SEC): Promise<string> {
        return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
            expiresIn,
        });
    }
}
