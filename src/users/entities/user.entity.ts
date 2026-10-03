import { Check, Column, Entity, Index, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
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

    @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
    createdAt!: Date;

    @OneToMany(
        () => Order,
        (order) => order.user,
    )
    orders!: Order[];
}
