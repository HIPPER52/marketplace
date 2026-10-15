import 'reflect-metadata';
import { OutboxRepository } from '../../messaging/repositories/outbox.repository';
import { CheckoutOutcome } from '../../orders/constants/outcome.constant';
import { CheckoutService } from '../../orders/services/checkout.service';
import type { CheckoutResult } from '../../orders/types/checkout.types';
import { AppDataSource } from '../data-source';

/**
 * Fifty checkouts at once against ten units of stock.
 *
 *   npm run demo:race
 *
 * No queue, no mutex, no `await` between them: Promise.all fires all fifty and the database
 * is the only thing deciding who wins. Exactly ten must — and the eleventh through fiftieth
 * must be told why, not silently given a unit that does not exist.
 *
 * Buyers are given far more money than they can spend on purpose. Stock has to be the only
 * limit; if a balance could run out mid-run, "exactly ten succeeded" would be a statement
 * about scheduling rather than about correctness.
 *
 * The script checks its own invariant and fails the process if the invariant broke, so a
 * regression is a red build rather than a number nobody reads.
 */

const ATTEMPTS = 50;
const STARTING_STOCK = 10;
const QUANTITY_PER_CALL = 1;
const BALANCE_CENTS = 100_000_000;

interface Tally {
    created: number;
    outOfStock: number;
    insufficientFunds: number;
    unknownProduct: number;
}

async function main(): Promise<void> {
    const ds = await AppDataSource.initialize();

    try {
        // ---- fixture: the run owns its starting conditions -----------------------------
        const products = await ds.query<{ id: string; title: string }[]>(
            'SELECT id, title FROM products ORDER BY title LIMIT 1',
        );
        const product = products[0];

        if (product === undefined) {
            throw new Error('No products in the database. Run `npm run seed` first.');
        }

        const buyers = await ds.query<{ id: string }[]>('SELECT id FROM users ORDER BY id');

        if (buyers.length === 0) {
            throw new Error('No customers in the database. Run `npm run seed` first.');
        }

        await ds.query('UPDATE products SET in_stock = $2 WHERE id = $1', [
            product.id,
            STARTING_STOCK,
        ]);
        await ds.query('UPDATE users SET balance_cents = $1', [BALANCE_CENTS]);

        const ordersBefore = await countRows(ds, 'orders');
        const jobsBefore = await countRows(ds, 'jobs');

        console.log(`product:  ${product.title}`);
        console.log(`stock:    ${STARTING_STOCK}`);
        console.log(`buyers:   ${buyers.length}`);
        console.log(`firing ${ATTEMPTS} concurrent checkouts of ${QUANTITY_PER_CALL}…\n`);

        // ---- the race ------------------------------------------------------------------
        // The outbox row rides along in every one of the fifty transactions.
        const checkout = new CheckoutService(ds, new OutboxRepository());
        const startedAt = Date.now();

        const results = await Promise.all(
            Array.from({ length: ATTEMPTS }, (_, index) =>
                checkout.checkout({
                    userId: buyers[index % buyers.length]?.id ?? '',
                    lines: [{ productId: product.id, quantity: QUANTITY_PER_CALL }],
                }),
            ),
        );

        const elapsedMs = Date.now() - startedAt;

        // ---- what the database says afterwards ------------------------------------------
        const tally = count(results);
        const [stockRow] = await ds.query<{ in_stock: number }[]>(
            'SELECT in_stock FROM products WHERE id = $1',
            [product.id],
        );
        const finalStock = Number(stockRow?.in_stock ?? Number.NaN);
        const negativeStock = await countRows(ds, 'products', 'in_stock < 0');
        const ordersCreated = (await countRows(ds, 'orders')) - ordersBefore;
        const jobsQueued = (await countRows(ds, 'jobs')) - jobsBefore;

        console.log(`attempts:                 ${ATTEMPTS}`);
        console.log(`successful:               ${tally.created}`);
        console.log(`rejected, out of stock:   ${tally.outOfStock}`);
        console.log(`rejected, no funds:       ${tally.insufficientFunds}`);
        console.log(`rejected, unknown product:${tally.unknownProduct}`);
        console.log(`final stock:              ${finalStock}`);
        console.log(`rows with negative stock: ${negativeStock}`);
        console.log(`orders created:           ${ordersCreated}`);
        console.log(`jobs queued:              ${jobsQueued}`);
        console.log(`elapsed:                  ${elapsedMs} ms`);

        // ---- the invariant --------------------------------------------------------------
        const failures = [
            check(
                tally.created === STARTING_STOCK,
                `successful ${tally.created}, expected ${STARTING_STOCK}`,
            ),
            check(finalStock === 0, `final stock ${finalStock}, expected 0`),
            check(negativeStock === 0, `${negativeStock} product rows went negative`),
            check(
                ordersCreated === tally.created,
                `${ordersCreated} orders for ${tally.created} successful checkouts`,
            ),
            check(
                jobsQueued === tally.created,
                `${jobsQueued} jobs for ${tally.created} orders — an order nobody will be told about`,
            ),
        ].filter((failure): failure is string => failure !== null);

        if (failures.length > 0) {
            console.error('\nFAIL — oversell or an orphaned row:\n');
            for (const failure of failures) {
                console.error(`  ${failure}`);
            }
            process.exitCode = 1;
            return;
        }

        console.log(
            '\nOK — ten units of stock produced ten orders and ten queued receipts, and the' +
                '\nother forty callers were told why. No row went negative.',
        );
    } finally {
        await ds.destroy();
    }
}

function count(results: CheckoutResult[]): Tally {
    const tally: Tally = { created: 0, outOfStock: 0, insufficientFunds: 0, unknownProduct: 0 };

    for (const result of results) {
        switch (result.outcome) {
            case CheckoutOutcome.Created:
                tally.created += 1;
                break;
            case CheckoutOutcome.OutOfStock:
                tally.outOfStock += 1;
                break;
            case CheckoutOutcome.InsufficientFunds:
                tally.insufficientFunds += 1;
                break;
            case CheckoutOutcome.UnknownProduct:
                tally.unknownProduct += 1;
                break;
        }
    }

    return tally;
}

async function countRows(ds: typeof AppDataSource, table: string, where = 'true'): Promise<number> {
    const rows = await ds.query<{ n: string }[]>(
        `SELECT count(*) AS n FROM "${table}" WHERE ${where}`,
    );

    return Number(rows[0]?.n ?? 0);
}

function check(passed: boolean, failure: string): string | null {
    return passed ? null : failure;
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
