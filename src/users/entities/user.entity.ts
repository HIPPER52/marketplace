import { Check, Column, Entity, Index, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { ROLES, Role } from '../../auth/constants/role.constant';
import { bigintCents } from '../../common/utils/money.util';
import { Order } from '../../orders/entities/order.entity';

/**
 * Customers. Mirrors the `users` table of db/schema.sql.
 *
 * Not part of the HTTP contract yet: openapi.yaml exposes no customer resource. Orders
 * are owned by someone, and HW-14 needs that owner to hang a transactional checkout on.
 */
@Entity('users')
@Check('users_email_shaped', `position('@' IN email) > 1`)
@Check('users_display_name_not_blank', 'length(btrim(display_name)) > 0')
@Check('users_balance_cents_nonnegative', 'balance_cents >= 0')
@Check('users_role_known', `role IN (${ROLES.map((role) => `'${role}'`).join(', ')})`)
// Uniqueness is over lower(email), not over email: 'A@x.com' and 'a@x.com' are one
// account. Postgres has no UNIQUE constraint over an expression, only a unique index, and
// TypeORM's decorators cannot express one — so the migration creates it by hand and
// `synchronize: false` tells the schema differ to leave it alone rather than drop it.
@Index('idx_users_email_lower', { synchronize: false })
export class User {
    // bigint reaches JS as a string: the driver will not silently narrow a 64-bit value.
    // For an identifier that width is the point, so it stays a string — unlike money,
    // which src/common/utils/money.util.ts converts.
    @PrimaryGeneratedColumn('identity', { type: 'bigint', generatedIdentity: 'ALWAYS' })
    id!: string;

    /** Stored exactly as the customer typed it; matched case-insensitively. */
    @Column({ name: 'email', type: 'text' })
    email!: string;

    @Column({ name: 'display_name', type: 'text' })
    displayName!: string;

    /**
     * What the customer can spend, in integer minor units like every other amount here.
     *
     * The CHECK on the table is the floor under checkout: if the atomic UPDATE that debits
     * this ever gets its predicate wrong, Postgres answers 23514 rather than quietly
     * letting the balance go negative. Correctness does not rest on the application being
     * careful.
     */
    @Column({ name: 'balance_cents', type: 'bigint', default: 0, transformer: bigintCents })
    balanceCents!: number;

    /**
     * argon2id, with the library's own OWASP-aligned parameters. Nullable because the
     * rows that predate authentication have no password and must not be given one by a
     * migration — an account nobody can sign into is safer than an account whose password
     * is written in a file in this repository.
     */
    @Column({ name: 'password_hash', type: 'text', nullable: true })
    passwordHash!: string | null;

    /**
     * What kind of actor this is. **The source of truth** — the copy inside an access
     * token is a cache that can be up to one token lifetime stale, and every decision
     * reads this column instead.
     */
    @Column({ name: 'role', type: 'text', default: Role.Customer })
    role!: Role;

    @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
    createdAt!: Date;

    @OneToMany(
        () => Order,
        (order) => order.user,
    )
    orders!: Order[];
}
