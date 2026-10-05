import 'reflect-metadata';
import { DataSource, type Logger as TypeOrmLogger } from 'typeorm';
import { Order } from '../../orders/entities/order.entity';
import { OrderItem } from '../../orders/entities/order-item.entity';
import { Product } from '../../products/entities/product.entity';
import { dataSourceOptions } from '../data-source';

/**
 * N+1, measured rather than asserted.
 *
 *   npm run demo:nplus1
 *   SHOW_SQL=1 npm run demo:nplus1     # echo every statement, not just count it
 *
 * The graph is order -> items -> product. Two levels, which is what makes the numbers
 * worth reading: the fixes cost 1 or 5 statements, and neither moves when the collection
 * does.
 *
 * Nothing in the naive version looks wrong. There is no `query` call in it, only `find`.
 * That is the whole problem — the cost is invisible in the code and visible only in the
 * SQL log, which is why this script turns that log into a counter.
 */

const TRUNCATE_SQL_AT = 110;

/** order -> items -> product. The constant a fixed strategy may not exceed is 1 + 2 x this. */
const RELATION_LEVELS = 2;
const CONSTANT_BUDGET = 1 + 2 * RELATION_LEVELS;

/** Counts statements; echoes them when SHOW_SQL=1. */
class QueryCountLogger implements TypeOrmLogger {
    count = 0;

    constructor(private readonly echo: boolean) {}

    reset(): void {
        this.count = 0;
    }

    logQuery(query: string): void {
        this.count += 1;

        if (this.echo) {
            const flat = query.replace(/\s+/g, ' ').trim();
            const shown =
                flat.length > TRUNCATE_SQL_AT ? `${flat.slice(0, TRUNCATE_SQL_AT)}…` : flat;
            console.log(`      ${String(this.count).padStart(3)} │ ${shown}`);
        }
    }

    logQueryError(error: string | Error, query: string): void {
        console.error(`SQL failed: ${String(error)}\n  ${query}`);
    }

    logQuerySlow(): void {}
    logSchemaBuild(): void {}
    logMigration(): void {}
    log(): void {}
}

interface Measurement {
    strategy: string;
    queries: number;
    note: string;
    /**
     * Whether this strategy is held to CONSTANT_BUDGET. The naive one is not — blowing the
     * budget is what it is here to demonstrate. Everything else is a fix, and a fix that
     * stops being constant is a regression this script has to fail on.
     */
    budgeted: boolean;
}

async function main(): Promise<void> {
    const showSql = process.env.SHOW_SQL === '1';
    const logger = new QueryCountLogger(showSql);

    // logging: ['query'] is what routes every statement through the logger above. Without
    // it the counter stays at zero and N+1 stays invisible.
    const ds = new DataSource({ ...dataSourceOptions, logging: ['query'], logger });

    await ds.initialize();

    try {
        const orders = ds.getRepository(Order);
        const items = ds.getRepository(OrderItem);
        const products = ds.getRepository(Product);
        const total = await orders.count();

        if (total === 0) {
            throw new Error('No orders in the database. Run `npm run seed` first.');
        }

        const runs: { take: number; measured: Measurement[] }[] = [];

        for (const take of [Math.ceil(total / 2), total]) {
            console.log(`\n═══ a page of ${take} orders (of ${total}) ═══`);
            const measured: Measurement[] = [];

            const measure = async (
                strategy: string,
                note: string,
                run: () => Promise<unknown>,
                budgeted = true,
            ): Promise<void> => {
                if (showSql) {
                    console.log(`\n  ${strategy}`);
                }

                logger.reset();
                await run();
                measured.push({ strategy, queries: logger.count, note, budgeted });
            };

            await measure(
                'naive — find() in a loop',
                'one for the page, one per order, one per line item',
                async () => {
                    const page = await orders.find({ order: { id: 'ASC' }, take });

                    for (const order of page) {
                        // loadRelationIds leaves `product` as the raw foreign key instead
                        // of fetching the row — the honest shape of code that does not
                        // realise it is about to fetch each one separately.
                        const lines = await items.find({
                            where: { order: { id: order.id } },
                            loadRelationIds: true,
                        });

                        for (const line of lines) {
                            const productId = line.product as unknown as string;
                            await products.findOne({ where: { id: productId } });
                        }
                    }
                },
                false,
            );

            await measure(
                'relations (whole collection)',
                'one LEFT JOIN, one statement — the default for a graph of objects',
                () =>
                    orders.find({ order: { id: 'ASC' }, relations: { items: { product: true } } }),
            );

            await measure(
                'relations (a page of take)',
                'two: a page of parent ids cannot be a LIMIT on a joined result set',
                () =>
                    orders.find({
                        order: { id: 'ASC' },
                        take,
                        relations: { items: { product: true } },
                    }),
            );

            await measure(
                'leftJoinAndSelect',
                'the same statement, with somewhere to put a WHERE on the relation',
                () =>
                    orders
                        .createQueryBuilder('o')
                        .leftJoinAndSelect('o.items', 'item')
                        .leftJoinAndSelect('item.product', 'product')
                        .orderBy('o.id', 'ASC')
                        .take(take)
                        .getMany(),
            );

            await measure(
                "relationLoadStrategy: 'query'",
                '1 + 2 x 2 levels: constant, and no row multiplication from a join',
                () =>
                    orders.find({
                        order: { id: 'ASC' },
                        take,
                        relations: { items: { product: true } },
                        relationLoadStrategy: 'query',
                    }),
            );

            report(measured);
            runs.push({ take, measured });
        }

        const failures = verdict(runs);

        if (failures.length > 0) {
            console.error('\nFAIL — a fixed strategy is no longer constant:\n');
            for (const failure of failures) {
                console.error(`  ${failure}`);
            }
            process.exitCode = 1;
            return;
        }

        console.log(
            '\nOK — the naive count tracks the data; every fix stayed inside the budget of\n' +
                `${CONSTANT_BUDGET} and did not move when the page doubled. That invariance is the\n` +
                'property worth checking, not the number itself.',
        );
    } finally {
        await ds.destroy();
    }
}

/**
 * Two regressions this script exists to catch, and the reason it sets an exit code rather
 * than printing a warning nobody reads: a fix that exceeds 1 + 2 x levels, and a fix whose
 * cost moves when the page size does. The second is the real N+1 tell — a count that is
 * merely large is slow, a count that grows is broken.
 */
function verdict(runs: { take: number; measured: Measurement[] }[]): string[] {
    const failures: string[] = [];

    for (const { take, measured } of runs) {
        for (const m of measured.filter((candidate) => candidate.budgeted)) {
            if (m.queries > CONSTANT_BUDGET) {
                failures.push(
                    `${m.strategy}: ${m.queries} queries at a page of ${take}, budget is ${CONSTANT_BUDGET}`,
                );
            }
        }
    }

    const [first, ...rest] = runs;

    if (first !== undefined) {
        for (const baseline of first.measured.filter((m) => m.budgeted)) {
            for (const run of rest) {
                const later = run.measured.find((m) => m.strategy === baseline.strategy);

                if (later !== undefined && later.queries !== baseline.queries) {
                    failures.push(
                        `${baseline.strategy}: ${baseline.queries} queries at a page of ${first.take}, ` +
                            `${later.queries} at ${run.take} — it scales with the data`,
                    );
                }
            }
        }
    }

    return failures;
}

function report(measured: Measurement[]): void {
    const width = Math.max(...measured.map((m) => m.strategy.length));

    for (const m of measured) {
        const overBudget = m.queries > CONSTANT_BUDGET;
        const flag = overBudget ? (m.budgeted ? ' <-- FAIL' : ' <-- N+1') : '         ';
        console.log(
            `  ${m.strategy.padEnd(width)}  ${String(m.queries).padStart(3)} queries${flag}  ${m.note}`,
        );
    }
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
