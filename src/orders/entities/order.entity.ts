import {
    Check,
    Column,
    Entity,
    Index,
    JoinColumn,
    ManyToOne,
    OneToMany,
    PrimaryGeneratedColumn,
    RelationId,
} from 'typeorm';
import { CURRENCIES, Currency } from '../../common/constants/currency.constant';
import { bigintCents } from '../../common/utils/money.util';
import { User } from '../../users/entities/user.entity';
import { ORDER_STATUSES, OrderStatus } from '../constants/order-status.constant';
import { OrderItem } from './order-item.entity';

const CURRENCY_LIST = CURRENCIES.map((currency) => `'${currency}'`).join(', ');
const STATUS_LIST = ORDER_STATUSES.map((status) => `'${status}'`).join(', ');

/**
 * Customer orders. Mirrors the `orders` table of db/schema.sql.
 *
 * The CHECK constraints are generated from the same constants the TypeScript union comes
 * from, so a status the contract gains is a status the database accepts — in one edit.
 */
@Entity('orders')
@Check('orders_status_known', `status IN (${STATUS_LIST})`)
@Check('orders_total_cents_nonnegative', 'total_cents >= 0')
@Check('orders_currency_known', `currency IN (${CURRENCY_LIST})`)
// q1 — "this customer's orders for a period". Equality left, range right.
@Index('idx_orders_user_id_created_at', ['user', 'createdAt'])
// q2 — the admin queue. PARTIAL: `pending` is about 5% of the table and the other 95% is
// what this screen never opens, so indexing it would be disk and write time for entries
// no query reads.
@Index('idx_orders_pending_created_at', ['createdAt'], {
    where: `status = '${OrderStatus.Pending}'`,
})
export class Order {
    @PrimaryGeneratedColumn('uuid')
    id!: string;

    /**
     * RESTRICT: a customer with order history cannot be deleted out from under it.
     * Deleting the person must not silently delete the record that they bought something.
     */
    @ManyToOne(
        () => User,
        (user) => user.orders,
        { nullable: false, onDelete: 'RESTRICT' },
    )
    @JoinColumn({ name: 'user_id' })
    user!: User;

    /**
     * The owner's id without loading the owner. The realtime gateway answers one
     * question — "is this order yours?" — and joining the users table to answer it would
     * be a row fetched to look at one column.
     */
    @RelationId((order: Order) => order.user)
    userId!: string;

    @Column({ name: 'status', type: 'text', default: OrderStatus.Pending })
    status!: OrderStatus;

    @Column({ name: 'total_cents', type: 'bigint', default: 0, transformer: bigintCents })
    totalCents!: number;

    @Column({ name: 'currency', type: 'text', default: Currency.UAH })
    currency!: Currency;

    @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
    createdAt!: Date;

    /**
     * `cascade: true` is about saving, not deleting: save(order) writes its items in the
     * same call. What happens on delete is onDelete: 'CASCADE' on the child side, and
     * that one lives in the database schema, so it holds even for a DELETE issued from
     * psql that never passes through this code.
     */
    @OneToMany(
        () => OrderItem,
        (item) => item.order,
        { cascade: true },
    )
    items!: OrderItem[];
}
