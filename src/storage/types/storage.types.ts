/** Seconds, named so a signature cannot be read as "five" and meant as milliseconds. */
export interface Duration {
    seconds: number;
}

/** One part of a multipart upload, as `CompleteMultipartUpload` wants them. */
export interface UploadedPart {
    partNumber: number;
    eTag: string;
}

/** What `HeadObject` tells us, in the two fields anything here reads. */
export interface ObjectHead {
    sizeBytes: number;
    eTag: string;
    contentType: string | undefined;
    cacheControl: string | undefined;
}

/**
 * Whether the bucket's lifecycle rule is really in force.
 *
 * A result rather than a `void`, because the interesting case is a store that says yes
 * and means no — see `ObjectStore.installLifecycle`.
 */
export interface LifecycleOutcome {
    applied: boolean;
    reason?: string;
}
