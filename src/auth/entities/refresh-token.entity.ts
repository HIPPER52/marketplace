import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { User } from '../../users/entities/user.entity';

/**
 * One issued refresh token, and the thread back to the login that started it.
 *
 * ## Why the table stores a hash and not the token
 *
 * A refresh token is a bearer credential: whoever holds the string is the session. A table
 * of them is therefore a table of live sessions, and a database dump — a backup on a
 * laptop, a replica somebody forgot — hands over every one of them. What is stored is
 * `HMAC(pepper, token)`, and the pepper lives in the secret store rather than in the
 * database, so the dump alone is useless. A bare SHA-256 of a 32-byte random string is not
 * guessable either; the pepper is what makes the dump useless *even to somebody who also
 * has the algorithm*.
 *
 * ## Why there is a family
 *
 * Rotation alone guarantees nothing. If a stolen token is used once, the thief gets a new
 * pair and the honest client's next refresh fails — the honest client quietly logs in
 * again and the **thief's session continues**. The family is what makes the detected
 * replay actionable: every token descended from one login shares `family_id`, so when a
 * token that was already used shows up, there is something to revoke. RFC 9700 §4.14.2
 * requires either sender-constrained tokens or rotation *with replay detection*, and the
 * stored link between old and new exists precisely so the detection has teeth.
 *
 * That is also why "stateless refresh" is a contradiction: with nothing stored there is no
 * old-to-new link, no detection, and what you have is a second session that cannot be
 * revoked.
 */
@Entity('refresh_tokens')
// The lookup on every refresh is by hash. Unique because two live rows with one hash would
// mean the same string was issued twice, which is a bug this constraint turns into an error.
@Index('idx_refresh_tokens_token_hash', ['tokenHash'], { unique: true })
// Revoking a family touches every row of it.
@Index('idx_refresh_tokens_family_id', ['familyId'])
// The referencing side of the foreign key. Postgres indexes the referenced side for you
// and this one not at all, so without it deleting a user scans this table.
@Index('idx_refresh_tokens_user_id', ['userId'])
export class RefreshToken {
    @PrimaryGeneratedColumn('uuid')
    id!: string;

    /**
     * `HMAC-SHA256(REFRESH_TOKEN_PEPPER, token)`, hex. The token itself is never written
     * down — not here, not in a log.
     */
    @Column({ name: 'token_hash', type: 'text' })
    tokenHash!: string;

    /** Every token descended from one login. Revoked as a unit when a replay is detected. */
    @Column({ name: 'family_id', type: 'uuid' })
    familyId!: string;

    @ManyToOne(() => User, { nullable: false, onDelete: 'CASCADE' })
    @JoinColumn({ name: 'user_id' })
    user!: User;

    @Column({ name: 'user_id', type: 'bigint' })
    userId!: string;

    /**
     * When this token was exchanged for a new pair. Non-null means spent — and a spent
     * token arriving again is the compromise signal the whole design exists to catch.
     */
    @Column({ name: 'used_at', type: 'timestamptz', nullable: true })
    usedAt!: Date | null;

    /** Set on logout and on a detected replay. Non-null means refuse, whatever else is true. */
    @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
    revokedAt!: Date | null;

    /**
     * The family's absolute deadline, carried unchanged through every rotation. A rotation
     * that extended it would turn "rotate often" into "never expire".
     */
    @Column({ name: 'expires_at', type: 'timestamptz' })
    expiresAt!: Date;

    @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
    createdAt!: Date;
}
