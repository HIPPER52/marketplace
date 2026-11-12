/**
 * Where an upload is in its two-step contract.
 *
 * `pending` is written by `intent`, before a single byte exists: the row is a reservation
 * and a record of what was promised. `completed` is written by `commit`, and only after
 * `HeadObject` has confirmed the object is actually there.
 *
 * The gap between them is the interesting state and the reason the row exists at all. A
 * client that asks for an intent and then closes the tab leaves a `pending` row and
 * possibly some bytes; without the row there would be bytes in a bucket that nothing in
 * the database knows about — orphans, which mature systems accumulate by the terabyte and
 * can only find by paying for a listing.
 */
export const FileStatus = {
    Pending: 'pending',
    Completed: 'completed',
} as const;

export type FileStatus = (typeof FileStatus)[keyof typeof FileStatus];

export const FILE_STATUSES = Object.values(FileStatus);
