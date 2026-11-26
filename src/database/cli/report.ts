import 'reflect-metadata';
import { OrderStatus } from '../../orders/constants/order-status.constant';
import { Product } from '../../products/entities/product.entity';
import { AppDataSource } from '../data-source';

/**
 * Revenue by product — the report `find()` cannot write.
 *
 *   npm run report
 *
 * `find()` returns a graph of objects: rows of one table, optionally with the rows they
 * are related to. This question has no such shape. One line of output is not a product
 * and not an order item; it is three aggregates over a join, grouped. There is no entity
 * it could be hydrated into, which is why `getRawMany()` returns plain rows and the type
 * parameter is an interface written here rather than an entity.
 *
 * That is the boundary this project draws between Repository and QueryBuilder, and it is
 * not about difficulty: it is about whether the answer is an object the domain already
 * has a name for.
 */

/** Postgres returns SUM() and COUNT() as strings: a bigint need not fit in a double. */
interface RevenueRow {
    title: string;
    orders: string;
    units: string;
    revenue_cents: string;
}

const TOP_N = 10;
const CENTS_IN_UAH = 100;

async function main(): Promise<void> {
    const ds = await AppDataSource.initialize();

    try {
        const rows = await ds
            .getRepository(Product)
            .createQueryBuilder('p')
            .innerJoin('p.orderItems', 'oi')
            .innerJoin('oi.order', 'o')
            .select('p.title', 'title')
            .addSelect('COUNT(DISTINCT o.id)', 'orders')
            .addSelect('SUM(oi.quantity)', 'units')
            .addSelect('SUM(oi.subtotalCents)', 'revenue_cents')
            // A cancelled order is not revenue. The filter belongs in the database: pulling
            // every line item out and filtering in TypeScript would move the whole join
            // across the wire to throw most of it away.
            .where('o.status != :cancelled', { cancelled: OrderStatus.Cancelled })
            .groupBy('p.id')
            .addGroupBy('p.title')
            .orderBy('"revenue_cents"', 'DESC')
            .addOrderBy('p.title', 'ASC')
            .limit(TOP_N)
            .getRawMany<RevenueRow>();

        if (rows.length === 0) {
            console.log('No sales recorded. Run `npm run seed` first.');
            return;
        }

        const width = Math.max(...rows.map((row) => row.title.length));
        const money = (cents: string): string =>
            (Number(cents) / CENTS_IN_UAH).toLocaleString('uk-UA', {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
            });

        console.log(`Revenue by product, cancelled orders excluded, top ${TOP_N}:\n`);
        console.log(
            `  ${'product'.padEnd(width)}  ${'orders'.padStart(6)}  ${'units'.padStart(5)}  ${'revenue, UAH'.padStart(14)}`,
        );
        console.log(
            `  ${'-'.repeat(width)}  ${'-'.repeat(6)}  ${'-'.repeat(5)}  ${'-'.repeat(14)}`,
        );

        let totalCents = 0;

        for (const row of rows) {
            totalCents += Number(row.revenue_cents);
            console.log(
                `  ${row.title.padEnd(width)}  ${row.orders.padStart(6)}  ${row.units.padStart(5)}  ${money(row.revenue_cents).padStart(14)}`,
            );
        }

        console.log(
            `\n  ${'total'.padEnd(width)}  ${''.padStart(6)}  ${''.padStart(5)}  ${money(String(totalCents)).padStart(14)}`,
        );
    } finally {
        await ds.destroy();
    }
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
