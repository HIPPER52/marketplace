import type { MigrationInterface, QueryRunner } from 'typeorm';
import {
    DEMO_BUYER_BALANCE_CENTS,
    DEMO_BUYER_EMAIL,
    DEMO_BUYER_ID,
} from '../users/constants/demo-buyer.constant';

/**
 * The account `POST /orders` debits until authentication exists.
 *
 * HAND-WRITTEN. The generator compares entities to a schema and never writes data; this
 * migration adds no DDL at all. It is a migration rather than a seed because the
 * application depends on the row: checkout debits DEMO_BUYER_ID on every order, and a
 * database that has run every migration must be a database the service can serve from.
 * `npm run seed` is a convenience and is allowed not to have been run.
 *
 * `OVERRIDING SYSTEM VALUE` because users.id is GENERATED ALWAYS, and the id has to be
 * the constant the code names rather than whatever the sequence happens to hand out.
 * `ON CONFLICT DO NOTHING` because this must be re-runnable: a revert followed by a
 * re-apply, and the provider-verification state handlers that seat the same row, both
 * arrive here twice.
 */
export class DemoBuyer1791651369717 implements MigrationInterface {
    name = 'DemoBuyer1791651369717';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `INSERT INTO "users" ("id", "email", "display_name", "balance_cents")
             OVERRIDING SYSTEM VALUE
             VALUES ($1, $2, $3, $4)
             ON CONFLICT DO NOTHING`,
            [DEMO_BUYER_ID, DEMO_BUYER_EMAIL, 'Demo buyer', DEMO_BUYER_BALANCE_CENTS],
        );

        // The identity sequence has not moved — it would hand out 1 again, and the next
        // INSERT without OVERRIDING would fail on the primary key.
        await queryRunner.query(
            `SELECT setval(
                 pg_get_serial_sequence('users', 'id'),
                 GREATEST((SELECT max(id) FROM "users"), $1::bigint)
             )`,
            [DEMO_BUYER_ID],
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // orders.user_id is ON DELETE RESTRICT: a buyer with history is not deletable,
        // and a migration must not be the thing that decides otherwise.
        await queryRunner.query(
            `DELETE FROM "users"
              WHERE "id" = $1
                AND NOT EXISTS (SELECT 1 FROM "orders" WHERE "user_id" = $1)`,
            [DEMO_BUYER_ID],
        );
    }
}
