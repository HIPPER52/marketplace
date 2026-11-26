import {
    Check,
    Column,
    Entity,
    Index,
    JoinColumn,
    ManyToOne,
    PrimaryGeneratedColumn,
} from 'typeorm';
import { Order } from '../../orders/entities/order.entity';
import { JOB_KINDS, JOB_STATUSES, JobKind, JobStatus } from '../constants/job-status.constant';

const STATUS_LIST = JOB_STATUSES.map((status) => `'${status}'`).join(', ');
const KIND_LIST = JOB_KINDS.map((kind) => `'${kind}'`).join(', ');

/**
 * Post-processing work, queued inside the same transaction that created the order.
 *
 * A queue table rather than a broker, deliberately: enqueueing in the same transaction as
 * the order is what makes "order exists but nobody was told" impossible. A broker cannot
 * join that transaction, which is the problem the transactional outbox pattern exists to
 * solve — and that is where this table goes in #19.
 *
 * Workers claim rows with FOR UPDATE SKIP LOCKED: the lock lives for the whole transaction,
 * so a worker that dies before COMMIT silently returns its job to the queue.
 */
@Entity('jobs')
@Check('jobs_status_known', `status IN (${STATUS_LIST})`)
@Check('jobs_kind_known', `kind IN (${KIND_LIST})`)
@Check('jobs_processed_nonnegative', 'processed >= 0')
// The claim query is `WHERE status = 'new' ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`, and
// a queue is mostly done rows: indexing the whole table would be paying for history nobody
// queries. Partial, for the same reason idx_orders_pending_created_at is.
@Index('idx_jobs_new', ['id'], { where: `status = '${JobStatus.New}'` })
export class Job {
    @PrimaryGeneratedColumn('identity', { type: 'bigint', generatedIdentity: 'ALWAYS' })
    id!: string;

    @Column({ name: 'kind', type: 'text' })
    kind!: JobKind;

    @Column({ name: 'status', type: 'text', default: JobStatus.New })
    status!: JobStatus;

    /**
     * Nullable: a job is usually about an order, but the queue is not only for orders — the
     * worker demo seeds synthetic jobs, and maintenance work has no order either.
     * CASCADE because a receipt for a deleted order is nothing to send.
     */
    @ManyToOne(() => Order, { nullable: true, onDelete: 'CASCADE' })
    @JoinColumn({ name: 'order_id' })
    order!: Order | null;

    @Column({ name: 'payload', type: 'jsonb', default: () => `'{}'::jsonb` })
    payload!: Record<string, unknown>;

    /** Which worker claimed it. Null until someone does. */
    @Column({ name: 'worker', type: 'text', nullable: true })
    worker!: string | null;

    /**
     * How many times this job was carried out. The whole point of SKIP LOCKED is that this
     * never exceeds 1 — `npm run demo:workers` fails the process if it does.
     */
    @Column({ name: 'processed', type: 'int', default: 0 })
    processed!: number;

    @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
    createdAt!: Date;

    @Column({ name: 'processed_at', type: 'timestamptz', nullable: true })
    processedAt!: Date | null;
}
