import 'reflect-metadata';
import type { EntityManager } from 'typeorm';
import { AppDataSource } from '../data-source';
import { type RetryAttempt, sleep, withRetry } from '../utils/with-retry.util';

/**
 * Two transactions, one row, one snapshot each.
 *
 *   npm run demo:retry
 *
 * Both read the same balance under REPEATABLE READ, both think for a moment, both write
 * back a number they computed from what they read. Under READ COMMITTED this is the lost
 * update from the lecture: the second write silently overwrites the first and nobody is
 * told. Under REPEATABLE READ the database refuses — 40001, "could not serialize access
 * due to concurrent update" — and the arithmetic comes out right instead.
 *
 * Which is the point: the isolation level does not fix the race on its own. It converts a
 * silent wrong answer into a loud, retryable one, and the retry is what fixes it. Choosing
 * REPEATABLE READ without a retry wrapper is choosing a production that fails "sometimes,
 * cannot reproduce".
 *
 * The timings make the conflict deterministic rather than likely: A reads at t≈0 and
 * commits at t≈150, B reads at t≈50 — before A's commit, so B's snapshot predates it — and
 * writes at t≈300. B is guaranteed to find the row changed under it.
 */

const CREDIT_CENTS = 5_000;
const DEBIT_CENTS = 3_000;
const THINK_A_MS = 150;
const THINK_B_MS = 250;
const B_STARTS_AFTER_MS = 50;

async function main(): Promise<void> {
    const ds = await AppDataSource.initialize();
    const retries: (RetryAttempt & { actor: string })[] = [];

    try {
        const accounts = await ds.query<{ id: string; display_name: string }[]>(
            'SELECT id, display_name FROM users ORDER BY id LIMIT 1',
        );
        const account = accounts[0];

        if (account === undefined) {
            throw new Error('No customers in the database. Run `npm run seed` first.');
        }

        const before = await balanceOf(ds, account.id);
        const expected = before + CREDIT_CENTS - DEBIT_CENTS;

        console.log(`account:  ${account.display_name}`);
        console.log(`balance:  ${before} cents`);
        console.log(`A adds    ${CREDIT_CENTS}, thinking for ${THINK_A_MS} ms`);
        console.log(`B takes   ${DEBIT_CENTS}, thinking for ${THINK_B_MS} ms`);
        console.log(`expected: ${expected} cents\n`);
        console.log(
            'Postgres will log a failed UPDATE below. That is the demonstration, not a\n' +
                'malfunction: it is the database refusing the write that would have lost A.\n',
        );

        const readModifyWrite = (actor: string, deltaCents: number, thinkMs: number) =>
            withRetry(
                ds,
                {
                    label: actor,
                    isolation: 'REPEATABLE READ',
                    onRetry: (attempt) => {
                        retries.push({ ...attempt, actor });
                        console.log(
                            `  [${actor}] attempt ${attempt.attempt} failed with ${attempt.code} — ` +
                                `retrying the whole transaction in ${attempt.backoffMs} ms`,
                        );
                        console.log(`        ${attempt.message}`);
                    },
                },
                async (manager: EntityManager) => {
                    // Read, think, write — the shape that loses updates. Deliberately so:
                    // the retry has to replay the read too, or it writes a number derived
                    // from a snapshot the database has already rejected.
                    const seen = await balanceOf(manager, account.id);
                    await sleep(thinkMs);
                    await manager.query('UPDATE users SET balance_cents = $2 WHERE id = $1', [
                        account.id,
                        seen + deltaCents,
                    ]);

                    return seen + deltaCents;
                },
            );

        await Promise.all([
            readModifyWrite('A', CREDIT_CENTS, THINK_A_MS),
            (async () => {
                await sleep(B_STARTS_AFTER_MS);

                return readModifyWrite('B', -DEBIT_CENTS, THINK_B_MS);
            })(),
        ]);

        const actual = await balanceOf(ds, account.id);

        console.log(`\nretries caught: ${retries.length}`);
        for (const retry of retries) {
            console.log(`  ${retry.actor}: ${retry.code} on attempt ${retry.attempt}`);
        }
        console.log(`final balance:  ${actual} cents`);
        console.log(`expected:       ${expected} cents`);

        const failures: string[] = [];

        if (retries.length === 0) {
            failures.push(
                'no 40001 or 40P01 was caught — the two transactions did not overlap, so ' +
                    'this run proved nothing',
            );
        }

        if (actual !== expected) {
            failures.push(
                `final balance ${actual}, expected ${expected} — ${expected - actual} cents ` +
                    'went missing, which is a lost update',
            );
        }

        if (failures.length > 0) {
            console.error('\nFAIL:\n');
            for (const failure of failures) {
                console.error(`  ${failure}`);
            }
            process.exitCode = 1;
            return;
        }

        console.log(
            `\nOK — ${retries.length} serialization failure(s) caught and replayed; the` +
                '\narithmetic survived. Only 40001 and 40P01 are retried: a check violation' +
                '\nwould fail the same way every time, and a lock timeout was a deliberate' +
                '\nrefusal to wait.',
        );
    } finally {
        await ds.destroy();
    }
}

async function balanceOf(
    runner: { query: (sql: string, parameters?: unknown[]) => Promise<unknown> },
    userId: string,
): Promise<number> {
    const rows = (await runner.query('SELECT balance_cents FROM users WHERE id = $1', [
        userId,
    ])) as { balance_cents: string }[];

    return Number(rows[0]?.balance_cents ?? Number.NaN);
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
