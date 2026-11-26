import { Injectable } from '@nestjs/common';
import { ProblemError, ProblemType } from '../../common/errors/problem.error';
import { FileStatus } from '../constants/file-status.constant';
import {
    MULTIPART_THRESHOLD_BYTES,
    PUT_EXPIRES_SEC,
    partCountFor,
    partSizeFor,
} from '../constants/storage.constant';
import type { StoredFile } from '../entities/stored-file.entity';
import { FilesRepository } from '../repositories/files.repository';
import { type GrantedUpload, UploadMode, type UploadRequest } from '../types/upload.types';
import { uploadKeyFor } from '../utils/object-key.util';
import { ObjectStore } from './object-store.service';
import { Presigner } from './presigner.service';

/**
 * The two-step upload contract: reserve, then confirm.
 *
 * ## Why two steps and not one
 *
 * The bytes do not come through here. That is the whole point of a presigned URL and it
 * is also the problem it creates: a service that never sees the upload has no idea
 * whether it happened. One step would mean believing the client, and a client that says
 * "done" without uploading leaves a row pointing at nothing; a client that uploads and
 * never says anything leaves an object nothing points at. Mature systems accumulate the
 * second kind by the terabyte and can only find them by paying for a listing.
 *
 * So: `intent` writes a `pending` row and hands out a narrow, short-lived grant.
 * `commit` asks the **store** whether the object is there, and only that answer promotes
 * the row. Neither half trusts the client, and the gap between them is swept by the
 * reaper in `jobs/`.
 *
 * ## Why the server composes the key
 *
 * Because the alternative is handing the client the right to write anywhere in the
 * bucket. `uploads/{ownerId}/{uuid}.{ext}` — the owner from a verified token, the uuid
 * ours, the extension from the content-type allowlist. The filename the client sent is
 * kept for display and goes nowhere near it.
 */
@Injectable()
export class UploadsService {
    constructor(
        private readonly files: FilesRepository,
        private readonly store: ObjectStore,
        private readonly presigner: Presigner,
    ) {}

    /**
     * Reserves a key and signs the grant.
     *
     * The branch at the bottom is the one decision: above the threshold this becomes the
     * multipart protocol, and the part size is **computed** from the declared size rather
     * than taken from a constant — a library with a hard-coded 5 MiB fails on anything
     * past 50 GB, and fails at the end.
     */
    async intent(request: UploadRequest): Promise<GrantedUpload> {
        const objectKey = uploadKeyFor(request.ownerId, request.contentType);

        if (request.sizeBytes <= MULTIPART_THRESHOLD_BYTES) {
            const row = await this.files.reserve({
                ownerId: request.ownerId,
                objectKey,
                contentType: request.contentType,
                uploadId: null,
            });

            return {
                file: row,
                mode: UploadMode.Single,
                expiresIn: PUT_EXPIRES_SEC,
                url: await this.presigner.put(objectKey, request.contentType),
            };
        }

        const uploadId = await this.store.createMultipart(objectKey, request.contentType);
        const row = await this.files.reserve({
            ownerId: request.ownerId,
            objectKey,
            contentType: request.contentType,
            uploadId,
        });

        const partSize = partSizeFor(request.sizeBytes);
        const parts = await Promise.all(
            Array.from({ length: partCountFor(request.sizeBytes) }, async (_unused, index) => ({
                partNumber: index + 1,
                url: await this.presigner.uploadPart(objectKey, uploadId, index + 1),
            })),
        );

        return {
            file: row,
            mode: UploadMode.Multipart,
            expiresIn: PUT_EXPIRES_SEC,
            uploadId,
            partSize,
            parts,
        };
    }

    /**
     * Confirms, by asking the store rather than the client.
     *
     * For a multipart row the object does not exist yet however many parts are paid for,
     * so this completes it first — with the part list **read back from the store**, not
     * one the client reported. `CompleteMultipartUpload` is the atomic switch: before it
     * there is no object, after it there is.
     */
    async commit(fileId: string, ownerId: string): Promise<StoredFile> {
        const row = await this.files.findById(fileId);

        if (row === null) {
            throw new ProblemError({
                status: 404,
                type: ProblemType.notFound,
                title: 'Resource not found',
                detail: `No upload with id ${fileId}.`,
            });
        }

        if (row.ownerId !== ownerId) {
            throw new ProblemError({
                status: 403,
                type: ProblemType.forbidden,
                title: 'Forbidden',
                detail: `Upload ${fileId} does not belong to you.`,
            });
        }

        if (row.status === FileStatus.Completed) {
            // Committing twice is the same request arriving twice — the second one is
            // answered with what the first one decided, not with an error. The same shape
            // as a replayed Idempotency-Key in #22.
            return row;
        }

        if (row.uploadId !== null) {
            await this.completeMultipart(row.objectKey, row.uploadId);
        }

        const head = await this.store.head(row.objectKey);

        if (head === null) {
            // The reservation exists and the object does not. This is the branch a
            // solution without HeadObject cannot have, and the one `demo:upload` prints
            // as `commit-without-bytes`.
            throw new ProblemError({
                status: 409,
                type: ProblemType.conflict,
                title: 'Nothing was uploaded',
                detail: `No object at ${row.objectKey}. The bytes never arrived, so there is nothing to commit.`,
            });
        }

        return this.files.complete(row.id, { sizeBytes: head.sizeBytes });
    }

    /**
     * Turns the parts into an object, with the part list **read back from the store**.
     *
     * Not a list the client reported: the store is the only party that knows what it
     * actually holds, and it is the one that has to agree the ETags. An empty list means
     * nothing was uploaded — the `HeadObject` above then finds nothing and the commit is
     * a 409, which is the right answer rather than a Complete over zero parts.
     */
    private async completeMultipart(objectKey: string, uploadId: string): Promise<void> {
        const parts = await this.store.listParts(objectKey, uploadId);

        if (parts.length === 0) {
            return;
        }

        await this.store.completeMultipart(objectKey, uploadId, parts);
    }
}
