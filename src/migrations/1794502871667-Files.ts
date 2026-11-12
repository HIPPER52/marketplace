import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The file list, which lives here and not in the bucket.
 *
 * Generated from `StoredFile`, then read. One statement was taken out of what the
 * generator proposed, in both directions: `ALTER TABLE "jobs" ALTER COLUMN "payload" SET
 * DEFAULT '{}'::jsonb`. The column already has that default — TypeORM renders it
 * differently from the way Postgres reports it — so the statement changes nothing and
 * applying it does not stop it being proposed again. It is the same no-op every migration
 * since #14 has left out.
 *
 * `object_key` is unique because it *is* the identity of the object, and the server is
 * what composes it. `owner_id` is `ON DELETE CASCADE`: a deleted account must not leave
 * rows pointing at a user who is gone, and the objects themselves are the reaper's job.
 *
 * Two indexes, both earning their disk. The partial one is what the reaper reads —
 * "reservations older than a day" — and a mature table is almost entirely completed rows,
 * so indexing those would be paying for history nobody queries. The other is the
 * referencing side of the foreign key, which Postgres never creates for you.
 */
export class Files1794502871667 implements MigrationInterface {
    name = 'Files1794502871667';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `CREATE TABLE "files" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "object_key" text NOT NULL, "owner_id" bigint NOT NULL, "status" text NOT NULL DEFAULT 'pending', "content_type" text NOT NULL, "size_bytes" bigint, "upload_id" text, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "completed_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "UQ_6c57037b6168cbed8f265636656" UNIQUE ("object_key"), CONSTRAINT "files_size_bytes_nonnegative" CHECK (size_bytes IS NULL OR size_bytes >= 0), CONSTRAINT "files_status_known" CHECK (status IN ('pending', 'completed')), CONSTRAINT "PK_6c16b9093a142e0e7613b04a3d9" PRIMARY KEY ("id"))`,
        );

        await queryRunner.query(`CREATE INDEX "idx_files_owner_id" ON "files" ("owner_id") `);

        await queryRunner.query(
            `CREATE INDEX "idx_files_pending_created_at" ON "files" ("created_at") WHERE status = 'pending'`,
        );

        await queryRunner.query(
            `ALTER TABLE "files" ADD CONSTRAINT "FK_4bc1db1f4f34ec9415acd88afdb" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `ALTER TABLE "files" DROP CONSTRAINT "FK_4bc1db1f4f34ec9415acd88afdb"`,
        );

        await queryRunner.query(`DROP INDEX "public"."idx_files_pending_created_at"`);

        await queryRunner.query(`DROP INDEX "public"."idx_files_owner_id"`);

        await queryRunner.query(`DROP TABLE "files"`);
    }
}
