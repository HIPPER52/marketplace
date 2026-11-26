import { Check, Column, Entity, Index, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { CURRENCIES, Currency } from '../../common/constants/currency.constant';
import { bigintCents } from '../../common/utils/money.util';
import { OrderItem } from '../../orders/entities/order-item.entity';

const CURRENCY_LIST = CURRENCIES.map((currency) => `'${currency}'`).join(', ');

/**
 * The product catalogue. Mirrors the `products` table of db/schema.sql.
 *
 * `id`, `title`, `priceCents`, `currency` and `inStock` are the five fields
 * components/schemas/Product declares; `description` is storage-only until a later
 * assignment exposes it.
 */
@Entity('products')
@Check('products_title_not_blank', 'length(btrim(title)) > 0')
@Check('products_price_cents_nonnegative', 'price_cents >= 0')
@Check('products_in_stock_nonnegative', 'in_stock >= 0')
@Check('products_currency_known', `currency IN (${CURRENCY_LIST})`)
// GIN over tsvector — not a B-tree, and not something @Index can describe. Created in the
// migration; `synchronize: false` keeps the differ from proposing to drop it.
@Index('idx_products_search_vector', { synchronize: false })
export class Product {
    @PrimaryGeneratedColumn('uuid')
    id!: string;

    @Column({ name: 'title', type: 'text' })
    title!: string;

    @Column({ name: 'description', type: 'text', default: '' })
    description!: string;

    @Column({ name: 'price_cents', type: 'bigint', transformer: bigintCents })
    priceCents!: number;

    @Column({ name: 'currency', type: 'text', default: Currency.UAH })
    currency!: Currency;

    @Column({ name: 'in_stock', type: 'int', default: 0 })
    inStock!: number;

    @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
    createdAt!: Date;

    /**
     * Maintained by Postgres, never by hand: no code path can add a product the search
     * index cannot see. Left out of SELECTs — nothing in the application reads a
     * tsvector, only the index does.
     */
    @Column({
        name: 'search_vector',
        type: 'tsvector',
        asExpression: `to_tsvector('simple', title || ' ' || description)`,
        generatedType: 'STORED',
        select: false,
        nullable: true,
    })
    searchVector!: string;

    @OneToMany(
        () => OrderItem,
        (item) => item.product,
    )
    orderItems!: OrderItem[];
}
