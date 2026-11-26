import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The initial schema, generated with `npm run migrate:generate` and then read.
 *
 * Two statements below are hand-written, marked HAND-WRITTEN where they appear. TypeORM's
 * decorators describe a column list and an optional WHERE, and neither of these is that:
 * one indexes an expression, the other uses a different index type entirely. Both entities
 * declare the index with `synchronize: false`, which tells the schema differ the index
 * exists and is not its business — so a later `migration:generate` neither re-creates nor
 * drops them.
 *
 * Everything else is as generated. Read before committing: the generator compares entities
 * to a schema, never to the data in it. A NOT NULL column added to a populated table will
 * fail here, and a rename reaches this file as DROP + ADD, which is a rename that loses
 * every value in the column.
 */

export class InitialSchema1791050803455 implements MigrationInterface {
    name = 'InitialSchema1791050803455';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `INSERT INTO "typeorm_metadata"("database", "schema", "table", "type", "name", "value") VALUES ($1, $2, $3, $4, $5, $6)`,
            [
                'marketplace',
                'public',
                'products',
                'GENERATED_COLUMN',
                'search_vector',
                "to_tsvector('simple', title || ' ' || description)",
            ],
        );
        await queryRunner.query(
            `CREATE TABLE "products" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "title" text NOT NULL, "description" text NOT NULL DEFAULT '', "price_cents" bigint NOT NULL, "currency" text NOT NULL DEFAULT 'UAH', "in_stock" integer NOT NULL DEFAULT '0', "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "search_vector" tsvector GENERATED ALWAYS AS (to_tsvector('simple', title || ' ' || description)) STORED, CONSTRAINT "products_currency_known" CHECK (currency IN ('UAH', 'USD', 'EUR')), CONSTRAINT "products_in_stock_nonnegative" CHECK (in_stock >= 0), CONSTRAINT "products_price_cents_nonnegative" CHECK (price_cents >= 0), CONSTRAINT "products_title_not_blank" CHECK (length(btrim(title)) > 0), CONSTRAINT "PK_0806c755e0aca124e67c0cf6d7d" PRIMARY KEY ("id"))`,
        );
        // HAND-WRITTEN. GIN, not B-tree: a B-tree holds one key per row, while a document
        // holds many lexemes and the question is "which rows contain this one". GIN is
        // that inverted mapping. @Index cannot choose an index method.
        await queryRunner.query(
            `CREATE INDEX "idx_products_search_vector" ON "products" USING GIN ("search_vector")`,
        );
        await queryRunner.query(
            `CREATE TABLE "users" ("id" bigint GENERATED ALWAYS AS IDENTITY NOT NULL, "email" text NOT NULL, "display_name" text NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "users_display_name_not_blank" CHECK (length(btrim(display_name)) > 0), CONSTRAINT "users_email_shaped" CHECK (position('@' IN email) > 1), CONSTRAINT "PK_a3ffb1c0c8416b9fc6f907b7433" PRIMARY KEY ("id"))`,
        );
        // HAND-WRITTEN. Uniqueness over lower(email), not over email: 'A@x.com' and
        // 'a@x.com' are one account, and a plain UNIQUE (email) admits both — after which
        // the lookup in src/database/cli/ and in q3 of HW-12 returns two people for one
        // address. Postgres has no UNIQUE table constraint over an expression, only a
        // unique index, so the constraint and the index that lookup needs are one object.
        await queryRunner.query(
            `CREATE UNIQUE INDEX "idx_users_email_lower" ON "users" (lower(email))`,
        );
        await queryRunner.query(
            `CREATE TABLE "orders" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "status" text NOT NULL DEFAULT 'pending', "total_cents" bigint NOT NULL DEFAULT '0', "currency" text NOT NULL DEFAULT 'UAH', "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "user_id" bigint NOT NULL, CONSTRAINT "orders_currency_known" CHECK (currency IN ('UAH', 'USD', 'EUR')), CONSTRAINT "orders_total_cents_nonnegative" CHECK (total_cents >= 0), CONSTRAINT "orders_status_known" CHECK (status IN ('pending', 'paid', 'shipped', 'cancelled')), CONSTRAINT "PK_710e2d4957aa5878dfe94e4ac2f" PRIMARY KEY ("id"))`,
        );
        await queryRunner.query(
            `CREATE INDEX "idx_orders_pending_created_at" ON "orders" ("created_at") WHERE status = 'pending'`,
        );
        await queryRunner.query(
            `CREATE INDEX "idx_orders_user_id_created_at" ON "orders" ("user_id", "created_at") `,
        );
        await queryRunner.query(
            `CREATE TABLE "order_items" ("id" bigint GENERATED ALWAYS AS IDENTITY NOT NULL, "quantity" integer NOT NULL, "unit_price_cents" bigint NOT NULL, "subtotal_cents" bigint NOT NULL, "order_id" uuid NOT NULL, "product_id" uuid NOT NULL, CONSTRAINT "order_items_one_line_per_product" UNIQUE ("order_id", "product_id"), CONSTRAINT "order_items_unit_price_cents_nonnegative" CHECK (unit_price_cents >= 0), CONSTRAINT "order_items_quantity_positive" CHECK (quantity > 0), CONSTRAINT "order_items_subtotal_matches" CHECK (subtotal_cents = unit_price_cents * quantity), CONSTRAINT "PK_005269d8574e6fac0493715c308" PRIMARY KEY ("id"))`,
        );
        await queryRunner.query(
            `CREATE INDEX "idx_order_items_product_id" ON "order_items" ("product_id") `,
        );
        await queryRunner.query(
            `ALTER TABLE "orders" ADD CONSTRAINT "FK_a922b820eeef29ac1c6800e826a" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "order_items" ADD CONSTRAINT "FK_145532db85752b29c57d2b7b1f1" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
        );
        await queryRunner.query(
            `ALTER TABLE "order_items" ADD CONSTRAINT "FK_9263386c35b6b242540f9493b00" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `ALTER TABLE "order_items" DROP CONSTRAINT "FK_9263386c35b6b242540f9493b00"`,
        );
        await queryRunner.query(
            `ALTER TABLE "order_items" DROP CONSTRAINT "FK_145532db85752b29c57d2b7b1f1"`,
        );
        await queryRunner.query(
            `ALTER TABLE "orders" DROP CONSTRAINT "FK_a922b820eeef29ac1c6800e826a"`,
        );
        await queryRunner.query(`DROP INDEX "public"."idx_order_items_product_id"`);
        await queryRunner.query(`DROP TABLE "order_items"`);
        await queryRunner.query(`DROP INDEX "public"."idx_orders_user_id_created_at"`);
        await queryRunner.query(`DROP INDEX "public"."idx_orders_pending_created_at"`);
        await queryRunner.query(`DROP TABLE "orders"`);
        // HAND-WRITTEN, mirroring up().
        await queryRunner.query(`DROP INDEX "public"."idx_users_email_lower"`);
        await queryRunner.query(`DROP TABLE "users"`);
        // HAND-WRITTEN, mirroring up().
        await queryRunner.query(`DROP INDEX "public"."idx_products_search_vector"`);
        await queryRunner.query(`DROP TABLE "products"`);
        await queryRunner.query(
            `DELETE FROM "typeorm_metadata" WHERE "type" = $1 AND "name" = $2 AND "database" = $3 AND "schema" = $4 AND "table" = $5`,
            ['GENERATED_COLUMN', 'search_vector', 'marketplace', 'public', 'products'],
        );
    }
}
