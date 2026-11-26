import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Everything a transactional checkout needs that the schema did not have: money on the
 * customer, and somewhere to queue the work that follows an order.
 *
 * Generated and then read. Nothing needed changing by hand this time, but the line worth
 * checking before committing is this one:
 *
 *   ALTER TABLE "users" ADD "balance_cents" bigint NOT NULL DEFAULT '0'
 *
 * NOT NULL on a table that already holds rows is the generator's classic failure, and it
 * is safe here only because of the DEFAULT — every existing customer gets a balance of
 * zero. Without it this migration would fail on any database that has been seeded.
 *
 * The partial index came through as written, predicate and all:
 *
 *   CREATE INDEX "idx_jobs_new" ON "jobs" ("id") WHERE status = 'new'
 */

export class BalanceAndJobQueue1791228956086 implements MigrationInterface {
    name = 'BalanceAndJobQueue1791228956086';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `CREATE TABLE "jobs" ("id" bigint GENERATED ALWAYS AS IDENTITY NOT NULL, "kind" text NOT NULL, "status" text NOT NULL DEFAULT 'new', "payload" jsonb NOT NULL DEFAULT '{}'::jsonb, "worker" text, "processed" integer NOT NULL DEFAULT '0', "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "processed_at" TIMESTAMP WITH TIME ZONE, "order_id" uuid, CONSTRAINT "jobs_processed_nonnegative" CHECK (processed >= 0), CONSTRAINT "jobs_kind_known" CHECK (kind IN ('order_receipt')), CONSTRAINT "jobs_status_known" CHECK (status IN ('new', 'done', 'failed')), CONSTRAINT "PK_cf0a6c42b72fcc7f7c237def345" PRIMARY KEY ("id"))`,
        );
        await queryRunner.query(
            `CREATE INDEX "idx_jobs_new" ON "jobs" ("id") WHERE status = 'new'`,
        );
        await queryRunner.query(
            `ALTER TABLE "users" ADD "balance_cents" bigint NOT NULL DEFAULT '0'`,
        );
        await queryRunner.query(
            `ALTER TABLE "users" ADD CONSTRAINT "users_balance_cents_nonnegative" CHECK (balance_cents >= 0)`,
        );
        await queryRunner.query(
            `ALTER TABLE "jobs" ADD CONSTRAINT "FK_2cb9942b3a4fd4674ebb20406ff" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `ALTER TABLE "jobs" DROP CONSTRAINT "FK_2cb9942b3a4fd4674ebb20406ff"`,
        );
        await queryRunner.query(
            `ALTER TABLE "users" DROP CONSTRAINT "users_balance_cents_nonnegative"`,
        );
        await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "balance_cents"`);
        await queryRunner.query(`DROP INDEX "public"."idx_jobs_new"`);
        await queryRunner.query(`DROP TABLE "jobs"`);
    }
}
