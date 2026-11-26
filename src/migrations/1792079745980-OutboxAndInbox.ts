import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The three tables that close the gap between a COMMIT and a broker.
 *
 *   - `outbox` — the event, written beside the order it is about, in one transaction.
 *   - `processed_messages` — the inbox: which message a consumer has already acted on.
 *   - `idempotency_keys` — `Idempotency-Key` with a server behind it instead of a Map.
 *
 * Generated from the entities, then read. One statement was taken out of what the
 * generator proposed, in both directions: `ALTER TABLE "jobs" ALTER COLUMN "payload" SET
 * DEFAULT '{}'::jsonb`. The column already has exactly that default — TypeORM renders it
 * differently from the way Postgres reports it, and applying the statement does not stop
 * it being proposed again. It is the same no-op the OrderReceipts migration left out, and
 * an unrelated no-op inside a feature migration is noise in the one file that has to be
 * read before it runs.
 *
 * `outbox_unpublished_idx` is partial on purpose. The table grows with every order while
 * the set of rows a relay reads stays small; indexing all of it would be disk and write
 * time spent on history nothing queries. `(created_at, id)` because that is the relay's
 * ORDER BY — a tie on the timestamp has to resolve the same way for every worker.
 */
export class OutboxAndInbox1792079745980 implements MigrationInterface {
    name = 'OutboxAndInbox1792079745980';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `CREATE TABLE "outbox" (
                 "id" uuid NOT NULL DEFAULT gen_random_uuid(),
                 "aggregate_type" text NOT NULL,
                 "aggregate_id" text NOT NULL,
                 "type" text NOT NULL,
                 "payload" jsonb NOT NULL,
                 "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                 "published_at" TIMESTAMP WITH TIME ZONE,
                 "attempts" integer NOT NULL DEFAULT '0',
                 CONSTRAINT "PK_340ab539f309f03bdaa14aa7649" PRIMARY KEY ("id")
             )`,
        );

        await queryRunner.query(
            `CREATE INDEX "outbox_unpublished_idx" ON "outbox" ("created_at", "id")
              WHERE published_at IS NULL`,
        );

        await queryRunner.query(
            `CREATE TABLE "processed_messages" (
                 "message_id" text NOT NULL,
                 "consumer" text NOT NULL,
                 "processed_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                 CONSTRAINT "PK_d4853eee97acfc588e49f9290d1"
                     PRIMARY KEY ("message_id", "consumer")
             )`,
        );

        await queryRunner.query(
            `CREATE TABLE "idempotency_keys" (
                 "key" text NOT NULL,
                 "request_hash" text NOT NULL,
                 "order_id" uuid,
                 "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                 CONSTRAINT "PK_0afd83cbf08c9d12089a9bffc5e" PRIMARY KEY ("key")
             )`,
        );

        await queryRunner.query(
            `CREATE INDEX "idx_idempotency_keys_order_id" ON "idempotency_keys" ("order_id")`,
        );

        await queryRunner.query(
            `ALTER TABLE "idempotency_keys"
                 ADD CONSTRAINT "FK_446856502ff1075430219299f33"
                 FOREIGN KEY ("order_id") REFERENCES "orders"("id")
                 ON DELETE CASCADE ON UPDATE NO ACTION`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `ALTER TABLE "idempotency_keys" DROP CONSTRAINT "FK_446856502ff1075430219299f33"`,
        );
        await queryRunner.query(`DROP INDEX "public"."idx_idempotency_keys_order_id"`);
        await queryRunner.query(`DROP TABLE "idempotency_keys"`);
        await queryRunner.query(`DROP TABLE "processed_messages"`);
        await queryRunner.query(`DROP INDEX "public"."outbox_unpublished_idx"`);
        await queryRunner.query(`DROP TABLE "outbox"`);
    }
}
