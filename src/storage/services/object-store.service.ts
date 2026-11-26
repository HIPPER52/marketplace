import {
    AbortMultipartUploadCommand,
    CompleteMultipartUploadCommand,
    CreateBucketCommand,
    CreateMultipartUploadCommand,
    DeleteObjectCommand,
    GetBucketLifecycleConfigurationCommand,
    GetObjectCommand,
    HeadBucketCommand,
    HeadObjectCommand,
    ListMultipartUploadsCommand,
    ListPartsCommand,
    PutBucketLifecycleConfigurationCommand,
    PutObjectCommand,
    S3Client,
} from '@aws-sdk/client-s3';
import { Inject, Injectable } from '@nestjs/common';
import { ABORT_INCOMPLETE_AFTER_DAYS, LIFECYCLE_RULE_ID } from '../constants/storage.constant';
import { STORAGE_BUCKET, STORAGE_CLIENT } from '../constants/storage.tokens';
import type { LifecycleOutcome, ObjectHead, UploadedPart } from '../types/storage.types';

/**
 * Everything this project asks of an object store, and nothing it does not.
 *
 * A thin wrapper rather than passing `S3Client` around, for one reason worth stating: the
 * bucket name belongs here and not at thirty call sites, and the handful of commands
 * below are the whole vocabulary — put, head, delete, and the five that make up the
 * multipart protocol. Anything else (listing objects to answer "what files does this user
 * have") is deliberately absent: that list lives in Postgres, because a listing is paid,
 * paginated at a thousand keys, and shows up in the bill rather than in a test.
 */
@Injectable()
export class ObjectStore {
    constructor(
        @Inject(STORAGE_CLIENT) readonly client: S3Client,
        @Inject(STORAGE_BUCKET) readonly bucket: string,
    ) {}

    /**
     * Makes sure the bucket is there, with its lifecycle rule.
     *
     * Called by every demo at its start rather than by an init container: a container
     * that creates a bucket races the store's own readiness, and a demo that has to clean
     * up after itself anyway is the natural place to ask. On real S3 the bucket is made
     * once by whoever owns the account and `HeadBucket` simply succeeds.
     */
    async ensureBucket(): Promise<LifecycleOutcome> {
        try {
            await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
        } catch (error: unknown) {
            if (statusOf(error) !== 404) {
                throw error;
            }

            await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
        }

        return this.installLifecycle();
    }

    async put(
        key: string,
        body: Buffer,
        options: { contentType?: string; cacheControl?: string } = {},
    ): Promise<void> {
        await this.client.send(
            new PutObjectCommand({
                Bucket: this.bucket,
                Key: key,
                Body: body,
                ContentType: options.contentType,
                CacheControl: options.cacheControl,
            }),
        );
    }

    /**
     * What the object is, or `null` when there is none.
     *
     * The `null` is the point: `commit` exists to ask this question, and a store that
     * answered "not found" with an exception would make the honest answer look like a
     * failure. 404 and 403 both mean "we cannot see an object there" — a bucket where the
     * key does not exist and the caller lacks `s3:ListBucket` answers 403 by design.
     */
    async head(key: string): Promise<ObjectHead | null> {
        try {
            const result = await this.client.send(
                new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
            );

            return {
                sizeBytes: result.ContentLength ?? 0,
                eTag: result.ETag ?? '',
                contentType: result.ContentType,
                cacheControl: result.CacheControl,
            };
        } catch (error: unknown) {
            if (statusOf(error) === 404 || statusOf(error) === 403) {
                return null;
            }

            throw error;
        }
    }

    async get(key: string): Promise<{ body: Buffer; head: ObjectHead }> {
        const result = await this.client.send(
            new GetObjectCommand({ Bucket: this.bucket, Key: key }),
        );

        if (result.Body === undefined) {
            throw new Error(`The store returned no body for ${key}.`);
        }

        const body = Buffer.from(await result.Body.transformToByteArray());

        return {
            body,
            head: {
                sizeBytes: result.ContentLength ?? body.length,
                eTag: result.ETag ?? '',
                contentType: result.ContentType,
                cacheControl: result.CacheControl,
            },
        };
    }

    /** Deleting what is not there is a success, in S3 and therefore here. */
    async delete(key: string): Promise<void> {
        await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    }

    // ---- the multipart protocol ---------------------------------------------------------

    async createMultipart(key: string, contentType?: string): Promise<string> {
        const result = await this.client.send(
            new CreateMultipartUploadCommand({
                Bucket: this.bucket,
                Key: key,
                ContentType: contentType,
            }),
        );

        if (result.UploadId === undefined) {
            throw new Error(`The store did not return an upload id for ${key}.`);
        }

        return result.UploadId;
    }

    /**
     * The parts the store already holds — **the question that makes this a recovery
     * protocol rather than an optimisation for big files.**
     *
     * A process that died knows nothing; the state is not in it, it is in the store. Ask
     * here and top up what is missing; skip the question and you upload a 5 GB file from
     * the beginning, which is what "supports large files" means when nobody checked.
     */
    async listParts(key: string, uploadId: string): Promise<UploadedPart[]> {
        const result = await this.client.send(
            new ListPartsCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId }),
        );

        return (result.Parts ?? [])
            .flatMap((part) =>
                part.PartNumber === undefined || part.ETag === undefined
                    ? []
                    : [{ partNumber: part.PartNumber, eTag: part.ETag }],
            )
            .sort((left, right) => left.partNumber - right.partNumber);
    }

    /**
     * Turns the parts into an object. **Atomic**: until this returns there is no object
     * at that key, however many parts are already paid for and stored.
     */
    async completeMultipart(key: string, uploadId: string, parts: UploadedPart[]): Promise<string> {
        const result = await this.client.send(
            new CompleteMultipartUploadCommand({
                Bucket: this.bucket,
                Key: key,
                UploadId: uploadId,
                MultipartUpload: {
                    Parts: parts.map((part) => ({
                        PartNumber: part.partNumber,
                        ETag: part.eTag,
                    })),
                },
            }),
        );

        return result.ETag ?? '';
    }

    async abortMultipart(key: string, uploadId: string): Promise<void> {
        await this.client.send(
            new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId }),
        );
    }

    /** Every upload left open under this prefix. What a demo cleans up before it starts. */
    async listIncomplete(prefix: string): Promise<{ key: string; uploadId: string }[]> {
        const result = await this.client.send(
            new ListMultipartUploadsCommand({ Bucket: this.bucket, Prefix: prefix }),
        );

        return (result.Uploads ?? []).flatMap((upload) =>
            upload.Key === undefined || upload.UploadId === undefined
                ? []
                : [{ key: upload.Key, uploadId: upload.UploadId }],
        );
    }

    /**
     * The minimum hygiene of any bucket anybody writes to — **and a claim this checks
     * rather than makes.**
     *
     * An interrupted multipart is billed although the object does not exist and does not
     * appear in a listing, so the tails of every crashed upload accumulate invisibly and
     * forever. It is also a different action from expiring old objects: an expiration
     * rule does not touch them, which is the first of the three lifecycle traps.
     *
     * The rule below is the one AWS wants. MinIO is a different matter, and it is worth
     * knowing exactly how: this build **answers `InvalidArgument` to a rule whose only
     * action is `AbortIncompleteMultipartUpload`**, and if a second action is added to
     * get past that, it accepts the document and silently drops the abort — a read-back
     * shows the rule without it. So the write is followed by a read, and what this
     * returns is what the store actually kept.
     *
     * That is why `jobs/` has a reaper. A lifecycle rule is the cheap answer where it
     * exists; where it does not, something has to do the aborting, and a rule nobody
     * verified is worse than no rule because it looks like the problem is handled.
     */
    async installLifecycle(): Promise<LifecycleOutcome> {
        try {
            await this.client.send(
                new PutBucketLifecycleConfigurationCommand({
                    Bucket: this.bucket,
                    LifecycleConfiguration: {
                        Rules: [
                            {
                                ID: LIFECYCLE_RULE_ID,
                                Status: 'Enabled',
                                // An empty Filter and not `{ Prefix: '' }`: S3 accepts
                                // both and MinIO answers the second with InvalidArgument.
                                Filter: {},
                                AbortIncompleteMultipartUpload: {
                                    DaysAfterInitiation: ABORT_INCOMPLETE_AFTER_DAYS,
                                },
                            },
                        ],
                    },
                }),
            );
        } catch (error: unknown) {
            return {
                applied: false,
                reason: `the store refused the rule: ${(error as Error).message}`,
            };
        }

        const kept = await this.client.send(
            new GetBucketLifecycleConfigurationCommand({ Bucket: this.bucket }),
        );

        const rule = (kept.Rules ?? []).find((candidate) => candidate.ID === LIFECYCLE_RULE_ID);

        if (rule?.AbortIncompleteMultipartUpload === undefined) {
            return {
                applied: false,
                reason: 'the store accepted the rule and dropped the abort action from it',
            };
        }

        return { applied: true };
    }
}

/** The HTTP status behind an SDK error, where there is one. */
export function statusOf(error: unknown): number | undefined {
    return (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
}
