import { Injectable, Logger } from '@nestjs/common';
import { ABANDONED_AFTER_MS, REAP_BATCH } from '../constants/reaper.constant';
import { FilesRepository } from '../repositories/files.repository';
import { ObjectStore } from './object-store.service';

/** What one sweep did, which is what the demo and the log line both report. */
export interface ReapResult {
    claimed: number;
    aborted: number;
    deleted: number;
}

/**
 * Sweeps up what the two-step contract leaves behind.
 *
 * ## Why anything is left behind
 *
 * `intent` writes a row and hands out a grant; `commit` promotes the row. Between them
 * sits a client that can close the tab, lose its connection or simply never come back —
 * and every one of those leaves a `pending` row, often with bytes beside it and sometimes
 * with an unfinished multipart upload. None of that is an error; it is the normal residue
 * of an upload nobody completed, and in a mature system it is measured in terabytes.
 *
 * ## Why the lifecycle rule is not enough
 *
 * A bucket rule is the cheap answer for the multipart tails, and this project installs
 * one. It is not the whole answer for two reasons. It does not touch the **row**, so the
 * database would keep reservations for objects that no longer exist. And it is not always
 * there: MinIO answers `InvalidArgument` to a rule whose only action is
 * `AbortIncompleteMultipartUpload`, and accepts-then-silently-drops it when another
 * action is added — see `ObjectStore.installLifecycle`, which reads the rule back rather
 * than assuming. Where the rule does not exist, this is the only thing doing the aborting.
 *
 * ## Order of operations
 *
 * Abort, then delete the object, then delete the row — the row **last**, because the row
 * is the only record of what to clean. A pass that deleted it first and then failed would
 * have turned a reservation into an orphan, which is precisely what this exists to
 * prevent.
 */
@Injectable()
export class UploadReaper {
    private readonly logger = new Logger(UploadReaper.name);

    constructor(
        private readonly files: FilesRepository,
        private readonly store: ObjectStore,
    ) {}

    async sweep(olderThanMs: number = ABANDONED_AFTER_MS): Promise<ReapResult> {
        const abandoned = await this.files.abandoned(
            new Date(Date.now() - olderThanMs),
            REAP_BATCH,
        );
        const result: ReapResult = { claimed: abandoned.length, aborted: 0, deleted: 0 };

        for (const row of abandoned) {
            if (row.uploadId !== null) {
                try {
                    await this.store.abortMultipart(row.objectKey, row.uploadId);
                    result.aborted += 1;
                } catch (error: unknown) {
                    // A tail the lifecycle rule or an earlier pass already took. The
                    // object below still has to go, and so does the row.
                    this.logger.debug(
                        `nothing to abort for ${row.objectKey}: ${
                            error instanceof Error ? error.message : String(error)
                        }`,
                    );
                }
            }

            await this.store.delete(row.objectKey);
            await this.files.remove(row.id);
            result.deleted += 1;
        }

        if (result.claimed > 0) {
            this.logger.log(
                `reaped ${result.deleted} abandoned upload(s), aborting ${result.aborted} multipart tail(s)`,
            );
        }

        return result;
    }
}
