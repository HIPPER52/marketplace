/**
 * How long a presigned PUT is good for.
 *
 * **Five minutes, and the number is the decision.** SigV4 permits seven days and that is
 * the usual reason people write seven days; it is the wrong reason. A presigned URL
 * cannot be revoked — it has no `jti`, no registry and nobody to ask (see the table in
 * README), so the only thing bounding the damage of a leak is the clock. The scenario
 * here is a human picking a file in a form and the browser starting the PUT immediately:
 * the window that needs covering is one slow upload on a bad connection, not a week of
 * somebody's inbox.
 *
 * Five minutes covers a 10 MiB avatar on a 300 kbit/s link with room to spare, and makes
 * a URL copied into a chat worthless by the time anybody opens it.
 */
export const PUT_EXPIRES_SEC = 5 * 60;

/**
 * And how long a *download* URL is good for.
 *
 * Shorter still, because this one is handed out by `GET /files/{id}` on every request:
 * the client never keeps it, it follows the redirect at once. A minute is generous.
 */
export const GET_EXPIRES_SEC = 60;

/**
 * Above this, one PUT becomes a multipart upload.
 *
 * Eight MiB rather than a round ten because it is just above the largest thing this
 * contract accepts in one piece without the recovery protocol being worth its three extra
 * round trips. Below it, a failed upload costs the whole file again — which for 8 MiB is
 * a few seconds.
 */
export const MULTIPART_THRESHOLD_BYTES = 8 * 1024 * 1024;

/** S3's own limits. Not ours to choose, and the arithmetic below depends on both. */
export const MAX_PARTS = 10_000;
export const MIN_PART_BYTES = 5 * 1024 * 1024;

/**
 * The size of one part, **computed from the file** rather than written down.
 *
 * A library with a hard-coded 5 MiB fails on anything past 50 GB — 10 000 × 5 MiB — and
 * fails at the end, after uploading all of it. The floor is S3's: every part except the
 * last must be at least 5 MiB, or `CompleteMultipartUpload` answers `EntityTooSmall`.
 */
export function partSizeFor(totalBytes: number): number {
    return Math.max(MIN_PART_BYTES, Math.ceil(totalBytes / MAX_PARTS));
}

/** How many parts a file of this size is cut into, at the size above. */
export function partCountFor(totalBytes: number): number {
    return Math.max(1, Math.ceil(totalBytes / partSizeFor(totalBytes)));
}

/**
 * Incomplete multipart uploads are billed although the object does not exist and does not
 * appear in a listing. This is the minimum hygiene of any bucket anybody writes to, and
 * it is a different action from "expire objects older than N days" — an expiry rule does
 * not touch these tails.
 */
export const ABORT_INCOMPLETE_AFTER_DAYS = 7;

/** What `Cache-Control` a content-addressed asset is stored with. See README, "Files". */
export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

/** The prefix uploads live under. The user id is a path segment, the key is server-made. */
export const UPLOAD_PREFIX = 'uploads';

/** And the prefix the edge serves from. */
export const ASSET_PREFIX = 'assets';

/** The id of the lifecycle rule, used to write it and to read back whether it stuck. */
export const LIFECYCLE_RULE_ID = 'abort-incomplete-multipart';
