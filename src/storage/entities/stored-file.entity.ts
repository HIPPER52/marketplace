import {
    Check,
    Column,
    Entity,
    Index,
    JoinColumn,
    ManyToOne,
    PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { FILE_STATUSES, FileStatus } from '../constants/file-status.constant';

const STATUS_LIST = FILE_STATUSES.map((status) => `'${status}'`).join(', ');

/**
 * What the application knows about an object in the store.
 *
 * **This table is the file list, not the bucket.** A listing is paid, paginated at a
 * thousand keys and slow, so "show me this user's files" is a `SELECT` here and never a
 * `ListObjectsV2` — an anti-pattern that shows up in the bill rather than in a test.
 *
 * The key is unique because it is the identity of the object; the owner is a foreign key
 * because an upload belongs to somebody and a deleted account must not leave rows
 * pointing at nothing. `upload_id` is null for a single PUT and carries the multipart
 * handle otherwise, which is what lets the reaper abort a tail that was never finished.
 */
@Entity('files')
@Check('files_status_known', `status IN (${STATUS_LIST})`)
@Check('files_size_bytes_nonnegative', 'size_bytes IS NULL OR size_bytes >= 0')
// The reaper asks "which reservations are older than a day", and a mature table is mostly
// completed rows: indexing all of them would be paying for history nobody queries. Partial,
// the same shape as idx_jobs_new.
@Index('idx_files_pending_created_at', ['createdAt'], {
    where: `status = '${FileStatus.Pending}'`,
})
// The referencing side of the foreign key. Postgres indexes the referenced side for you
// and this side not at all, so deleting a user would scan every file ever uploaded — and
// it is also the index "show me this user's files" reads.
@Index('idx_files_owner_id', ['ownerId'])
export class StoredFile {
    @PrimaryGeneratedColumn('uuid')
    id!: string;

    /** The object key, composed by the server. See utils/object-key.util.ts. */
    @Column({ name: 'object_key', type: 'text', unique: true })
    objectKey!: string;

    @ManyToOne(() => User, { nullable: false, onDelete: 'CASCADE' })
    @JoinColumn({ name: 'owner_id' })
    owner!: User;

    /**
     * The owner's id without loading the owner — and queryable, unlike a `@RelationId`.
     * Mapped read-only so the relation stays the single writer; see Order.userId for the
     * version of this that bit, and why that one is a RelationId instead.
     */
    @Column({ name: 'owner_id', type: 'bigint' })
    ownerId!: string;

    @Column({ name: 'status', type: 'text', default: FileStatus.Pending })
    status!: FileStatus;

    /** From the allowlist, never from the filename. */
    @Column({ name: 'content_type', type: 'text' })
    contentType!: string;

    /**
     * What the object turned out to weigh, filled in by `commit` from `HeadObject`.
     *
     * Null while pending: before the bytes exist there is nothing to record, and a size
     * the client declared would be a number the client chose.
     */
    @Column({ name: 'size_bytes', type: 'bigint', nullable: true })
    sizeBytes!: string | null;

    /** The multipart handle, or null when this was a single PUT. */
    @Column({ name: 'upload_id', type: 'text', nullable: true })
    uploadId!: string | null;

    @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
    createdAt!: Date;

    @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
    completedAt!: Date | null;
}
