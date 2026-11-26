import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Who people are, and the thread back to the login that said so.
 *
 * Generated from the entities, then read. One statement was taken out of what the
 * generator proposed, in both directions: `ALTER TABLE "jobs" ALTER COLUMN "payload" SET
 * DEFAULT '{}'::jsonb`. The column already has that default — TypeORM renders it
 * differently from the way Postgres reports it — so the statement changes nothing and
 * applying it does not stop it being proposed again. It is the same no-op the two previous
 * migrations left out.
 *
 * `password_hash` is **nullable**, and deliberately. The accounts that predate
 * authentication have no password, and a migration that invented one would be a migration
 * that writes a credential into this repository's history. An account nobody can sign into
 * is the safe state; `demo:auth` and friends create their own users with their own
 * passwords.
 *
 * `role` defaults to `customer`, so every existing row becomes a buyer — the least
 * privilege that keeps the shop working.
 *
 * The unique index on `token_hash` is not decoration. It is the lookup every refresh
 * performs, and unique because two live rows sharing a hash would mean one random string
 * was issued twice; the constraint turns that from a silent ambiguity into an error.
 */
export class AuthTokens1793291335084 implements MigrationInterface {
    name = 'AuthTokens1793291335084';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `CREATE TABLE "refresh_tokens" (
                 "id" uuid NOT NULL DEFAULT gen_random_uuid(),
                 "token_hash" text NOT NULL,
                 "family_id" uuid NOT NULL,
                 "user_id" bigint NOT NULL,
                 "used_at" TIMESTAMP WITH TIME ZONE,
                 "revoked_at" TIMESTAMP WITH TIME ZONE,
                 "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL,
                 "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                 CONSTRAINT "PK_7d8bee0204106019488c4c50ffa" PRIMARY KEY ("id")
             )`,
        );

        await queryRunner.query(
            `CREATE UNIQUE INDEX "idx_refresh_tokens_token_hash" ON "refresh_tokens" ("token_hash")`,
        );
        await queryRunner.query(
            `CREATE INDEX "idx_refresh_tokens_family_id" ON "refresh_tokens" ("family_id")`,
        );
        await queryRunner.query(
            `CREATE INDEX "idx_refresh_tokens_user_id" ON "refresh_tokens" ("user_id")`,
        );

        await queryRunner.query(
            `ALTER TABLE "refresh_tokens"
                 ADD CONSTRAINT "FK_3ddc983c5f7bcf132fd8732c3f4"
                 FOREIGN KEY ("user_id") REFERENCES "users"("id")
                 ON DELETE CASCADE ON UPDATE NO ACTION`,
        );

        await queryRunner.query(`ALTER TABLE "users" ADD "password_hash" text`);
        await queryRunner.query(`ALTER TABLE "users" ADD "role" text NOT NULL DEFAULT 'customer'`);
        await queryRunner.query(
            `ALTER TABLE "users" ADD CONSTRAINT "users_role_known"
                 CHECK (role IN ('customer', 'seller', 'admin'))`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "users" DROP CONSTRAINT "users_role_known"`);
        await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "role"`);
        await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "password_hash"`);
        await queryRunner.query(
            `ALTER TABLE "refresh_tokens" DROP CONSTRAINT "FK_3ddc983c5f7bcf132fd8732c3f4"`,
        );
        await queryRunner.query(`DROP INDEX "public"."idx_refresh_tokens_user_id"`);
        await queryRunner.query(`DROP INDEX "public"."idx_refresh_tokens_family_id"`);
        await queryRunner.query(`DROP INDEX "public"."idx_refresh_tokens_token_hash"`);
        await queryRunner.query(`DROP TABLE "refresh_tokens"`);
    }
}
