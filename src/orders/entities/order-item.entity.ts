import {
    Check,
    Column,
    Entity,
    Index,
    JoinColumn,
    ManyToOne,
    PrimaryGeneratedColumn,
    Unique,
} from 'typeorm';
import { bigintCents } from '../../common/utils/money.util';
import { Product } from '../../products/entities/product.entity';
import { Order } from './order.entity';

/**
 * Order line items. Mirrors the `order_items` table of db/schema.sql.
 *
 * This is the M:N between orders and products, and it is an explicit entity rather than
 * @ManyToMany because the relationship carries data of its own: how many, and at what
 * price. @ManyToMany would give a bare join table with nowhere to put either.
 */
@Entity('order_items')
// One line per product per order: two lines for the same product is a bug, not a bigger
// basket. It also gives the order_id foreign key the index it needs, because order_id
// leads — which is exactly what product_id does not get from it, hence the index below.
@Unique('order_items_one_line_per_product', ['order', 'product'])
// Postgres indexes the referenced side of a foreign key automatically and the referencing
// side not at all. Without this, deleting one product sequentially scans every line item.
@Index('idx_order_items_product_id', ['product'])
@Check('order_items_subtotal_matches', 'subtotal_cents = unit_price_cents * quantity')
@Check('order_items_quantity_positive', 'quantity > 0')
@Check('order_items_unit_price_cents_nonnegative', 'unit_price_cents >= 0')
export class OrderItem {
    @PrimaryGeneratedColumn('identity', { type: 'bigint', generatedIdentity: 'ALWAYS' })
    id!: string;

    /** CASCADE: a line item without its order is meaningless, so it follows the parent. */
    @ManyToOne(
        () => Order,
        (order) => order.items,
        { nullable: false, onDelete: 'CASCADE' },
    )
    @JoinColumn({ name: 'order_id' })
    order!: Order;

    /** RESTRICT: a product that has been sold is history, and history is not deletable. */
    @ManyToOne(
        () => Product,
        (product) => product.orderItems,
        { nullable: false, onDelete: 'RESTRICT' },
    )
    @JoinColumn({ name: 'product_id' })
    product!: Product;

    @Column({ name: 'quantity', type: 'int' })
    quantity!: number;

    /** The price at the moment of purchase, copied rather than joined: re-pricing a
     * product must never rewrite what a customer was charged. */
    @Column({ name: 'unit_price_cents', type: 'bigint', transformer: bigintCents })
    unitPriceCents!: number;

    @Column({ name: 'subtotal_cents', type: 'bigint', transformer: bigintCents })
    subtotalCents!: number;
}
