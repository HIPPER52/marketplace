import { Inject, Injectable } from '@nestjs/common';
import { DataSource, type Repository } from 'typeorm';
import type { Currency } from '../../common/constants/currency.constant';
import { DATA_SOURCE } from '../../database/constants/database.constants';
import { Product } from '../entities/product.entity';

/**
 * Reads of the catalogue. A repository rather than a QueryBuilder because every answer
 * here is a row of `products` and the rows it relates to — see README, "Repository or
 * QueryBuilder".
 */
@Injectable()
export class ProductsRepository {
    /**
     * How many times Postgres was actually asked for a card.
     *
     * The number `demo:cache` reports, and the only one worth reporting: a cache that
     * saved nothing still looks busy from the outside. Kept on the repository because that
     * is the last layer where "a read happened" and "a query ran" are the same event.
     */
    readonly reads = { cards: 0 };

    private readonly products: Repository<Product>;

    constructor(@Inject(DATA_SOURCE) dataSource: DataSource) {
        this.products = dataSource.getRepository(Product);
    }

    /**
     * One page plus the total, which is what turns into `next_cursor`.
     *
     * The order is `created_at, id` and not `created_at` alone: seeded rows share a
     * timestamp to the microsecond, and an unstable sort under OFFSET returns the same
     * product on two pages and drops another entirely.
     */
    async page(limit: number, offset: number): Promise<ProductPage> {
        const [rows, total] = await this.products.findAndCount({
            order: { createdAt: 'ASC', id: 'ASC' },
            skip: offset,
            take: limit,
        });

        return { rows, total };
    }

    /**
     * Adds a row to the catalogue.
     *
     * The only write in this repository, and it exists because `POST /products` is what
     * makes the role check mean something: a rule that nothing can break is a rule nobody
     * can be shown. `currency` falls back to the column default rather than to a literal
     * here — the contract makes it optional and the database already says what it is.
     */
    create(input: NewProduct): Promise<Product> {
        return this.products.save(
            this.products.create({
                title: input.title,
                priceCents: input.priceCents,
                ...(input.currency === undefined ? {} : { currency: input.currency }),
                inStock: input.inStock,
            }),
        );
    }

    findById(id: string): Promise<Product | null> {
        return this.products.findOne({ where: { id } });
    }

    /**
     * The product card: the row plus everything that has ever been sold of it.
     *
     * This is the expensive read of the catalogue, and deliberately so — it is a join
     * against `order_items` and an aggregate over every line that ever named this product,
     * so its cost grows with the history of the shop rather than with the size of the
     * catalogue. `GET /products/{id}` is the busiest route there is; served from Postgres
     * on every hit it is the query that shows up in a slow log first. That is what makes
     * it worth a cache, and what makes the cache measurable.
     *
     * A QueryBuilder rather than `find()`, because an output row here is not an entity:
     * two of its five columns come from a GROUP BY — see README, "Repository or
     * QueryBuilder".
     */
    async cardOf(id: string): Promise<ProductCardRow | null> {
        // Counted here rather than at the call site. "How many times did I call the
        // function" is not the question — "how many times did Postgres have to answer"
        // is, and this is the last place where the two are still the same number.
        this.reads.cards += 1;

        const rows = await this.products.manager.query<RawCard[]>(
            `SELECT p.id, p.title, p.price_cents, p.currency, p.in_stock,
                    coalesce(sum(oi.quantity), 0)::int       AS units_sold,
                    coalesce(sum(oi.subtotal_cents), 0)      AS revenue_cents
               FROM products p
               LEFT JOIN order_items oi ON oi.product_id = p.id
              WHERE p.id = $1
              GROUP BY p.id`,
            [id],
        );

        const row = rows[0];

        if (row === undefined) {
            return null;
        }

        return {
            id: row.id,
            title: row.title,
            // bigint reaches the driver as a string, and money converts while identifiers
            // do not — the rule from #13, applied to a raw row where no transformer runs.
            priceCents: Number(row.price_cents),
            currency: row.currency,
            inStock: Number(row.in_stock),
            unitsSold: Number(row.units_sold),
            revenueCents: Number(row.revenue_cents),
        };
    }
}

/** One page of the catalogue, plus what `next_cursor` is computed from. */
export interface ProductPage {
    rows: Product[];
    total: number;
}

/** What `create` is given. `currency` is optional because the column has a default. */
export interface NewProduct {
    title: string;
    priceCents: number;
    currency?: Currency;
    inStock: number;
}

/** What `cardOf` hands back. Not an entity: two columns are aggregates. */
export interface ProductCardRow {
    id: string;
    title: string;
    priceCents: number;
    currency: Currency;
    inStock: number;
    unitsSold: number;
    revenueCents: number;
}

interface RawCard {
    id: string;
    title: string;
    price_cents: string;
    currency: Currency;
    in_stock: number;
    units_sold: number;
    revenue_cents: string;
}
