import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `order_receipts` — the effect the `order.placed` consumer applies, and the constraint
 * that makes applying it twice a no-op.
 *
 * Generated from the entity, then read. Two things were taken out of what the generator
 * proposed:
 *
 *   - `ALTER TABLE "jobs" ALTER COLUMN "payload" SET DEFAULT '{}'::jsonb`, in both
 *     directions. The column already has exactly that default — `information_schema`
 *     says `'{}'::jsonb` — so the statement changes nothing. It appears because TypeORM
 *     compares the default it would have written against the one Postgres reports and
 *     renders them differently; applying it does not stop it being proposed again.
 *     An unrelated no-op inside a feature migration is noise in the one file that has to
 *     be read before it runs.
 *
 * The primary key *is* the foreign key: one column, `order_id`, which is the entire
 * idempotency argument. An order has one receipt, so issuing it is an operation that has
 * either happened or not, and `ON CONFLICT (order_id) DO NOTHING` is how a redelivered
 * message finds that out without a registry of seen message ids.
 *
 * ON DELETE CASCADE because a receipt for an order that no longer exists is nothing. The
 * foreign key is also load-bearing for `demo:dlq`: an event naming an order that does not
 * exist cannot be processed, ever, by anything — which is what a poison message is, and
 * is more honest than a handler that throws when it sees a magic value.
 */
export class OrderReceipts1791907283687 implements MigrationInterface {
    name = 'OrderReceipts1791907283687';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `CREATE TABLE "order_receipts" (
                 "order_id" uuid NOT NULL,
                 "event_id" uuid NOT NULL,
                 "total_cents" bigint NOT NULL,
                 "currency" text NOT NULL,
                 "issued_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                 CONSTRAINT "order_receipts_currency_known"
                     CHECK (currency IN ('UAH', 'USD', 'EUR')),
                 CONSTRAINT "order_receipts_total_cents_nonnegative" CHECK (total_cents >= 0),
                 CONSTRAINT "PK_d7b2656cc5c1aee6b36f76581a3" PRIMARY KEY ("order_id")
             )`,
        );

        await queryRunner.query(
            `ALTER TABLE "order_receipts"
                 ADD CONSTRAINT "FK_d7b2656cc5c1aee6b36f76581a3"
                 FOREIGN KEY ("order_id") REFERENCES "orders"("id")
                 ON DELETE CASCADE ON UPDATE NO ACTION`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `ALTER TABLE "order_receipts" DROP CONSTRAINT "FK_d7b2656cc5c1aee6b36f76581a3"`,
        );
        await queryRunner.query(`DROP TABLE "order_receipts"`);
    }
}
