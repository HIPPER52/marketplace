import { Check, Column, Entity, JoinColumn, OneToOne, PrimaryColumn } from 'typeorm';
import { CURRENCIES, Currency } from '../../common/constants/currency.constant';
import { bigintCents } from '../../common/utils/money.util';
import { Order } from './order.entity';

const CURRENCY_LIST = CURRENCIES.map((currency) => `'${currency}'`).join(', ');

/**
 * The receipt issued when an order is placed — and the reason a duplicate delivery is
 * harmless.
 *
 * `order_id` is the primary key, not a column beside one. That is the whole idempotency
 * strategy: an order has one receipt by definition, so `INSERT … ON CONFLICT (order_id)
 * DO NOTHING` is an operation that either has been applied or has not, and applying it
 * twice is indistinguishable from applying it once. No registry of seen message ids, no
 * cache, nothing to keep in step — the constraint that already had to exist is doing the
 * work.
 *
 * Idempotency is a property of the operation, and expressing the effect through a natural
 * key is how an operation gets it. `UPDATE … SET sent_count = sent_count + 1` would not
 * have it, and no amount of bookkeeping around such a statement makes it safe — it makes
 * the bookkeeping the thing that has to be correct instead.
 *
 * `event_id` is recorded but is not the key. It answers "which delivery wrote this" when
 * reading the table later; it does not decide whether to write. A key over the event id
 * would deduplicate messages, which is a weaker promise than deduplicating effects: two
 * different events about one order would both apply.
 *
 * The gap this does *not* close: the row and the broker's ack are two separate acts, so a
 * consumer that dies between them is redelivered and finds its own row — which is exactly
 * the case this design is for. The gap that remains is between marking and acting when
 * those are two writes; #22 closes it by putting both in one transaction.
 */
@Entity('order_receipts')
@Check('order_receipts_total_cents_nonnegative', 'total_cents >= 0')
@Check('order_receipts_currency_known', `currency IN (${CURRENCY_LIST})`)
export class OrderReceipt {
    @PrimaryColumn({ name: 'order_id', type: 'uuid' })
    orderId!: string;

    /**
     * CASCADE: a receipt for an order that no longer exists is nothing. The foreign key is
     * also what makes an event about an unknown order a genuine poison message rather than
     * a contrived one — the database refuses it, every time, for as long as it is retried.
     */
    @OneToOne(() => Order, { nullable: false, onDelete: 'CASCADE' })
    @JoinColumn({ name: 'order_id' })
    order!: Order;

    /** Which delivery wrote the row. Recorded, never consulted — see the note above. */
    @Column({ name: 'event_id', type: 'uuid' })
    eventId!: string;

    @Column({ name: 'total_cents', type: 'bigint', transformer: bigintCents })
    totalCents!: number;

    @Column({ name: 'currency', type: 'text' })
    currency!: Currency;

    @Column({ name: 'issued_at', type: 'timestamptz', default: () => 'now()' })
    issuedAt!: Date;
}
