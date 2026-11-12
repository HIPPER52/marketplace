import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { DataSource, EntityManager } from 'typeorm';
import type { Env } from '../../config/schemas/env.schema';
import { DATA_SOURCE } from '../../database/constants/database.constants';
import { REFRESH_BYTES } from '../constants/auth.constant';

export interface StoredRefresh {
    id: string;
    familyId: string;
    userId: string;
    usedAt: Date | null;
    revokedAt: Date | null;
    expiresAt: Date;
}

/** The row as Postgres hands it back — snake_case, and `claim` maps it. */
interface RefreshRow {
    id: string;
    family_id: string;
    user_id: string;
    used_at: Date | null;
    revoked_at: Date | null;
    expires_at: Date;
}

/** What `demo:reuse` prints: how many rows a family has, and how many still work. */
export interface FamilyState {
    rows: number;
    live: number;
}

export interface NewRefresh {
    userId: string;
    familyId: string;
    expiresAt: Date;
}

/**
 * The refresh-token table, and the only place a refresh token is turned into a row.
 *
 * The token is a 32-byte random string — 43 characters of base64url — and **it is never
 * stored**. What goes in the column is `HMAC-SHA256(pepper, token)`, where the pepper
 * comes from the secret store. A plain SHA-256 would already be unguessable; the pepper is
 * what makes a stolen database dump useless to somebody who also knows the algorithm,
 * because the table alone does not contain what is needed to recognise a token.
 */
@Injectable()
export class RefreshTokensRepository {
    private readonly pepper: string;

    constructor(
        @Inject(DATA_SOURCE) private readonly dataSource: DataSource,
        config: ConfigService<Env, true>,
    ) {
        this.pepper = config.get('REFRESH_TOKEN_PEPPER', { infer: true });
    }

    /** A fresh opaque token. Not a JWT: there is nothing in it to read. */
    mint(): string {
        return randomBytes(REFRESH_BYTES).toString('base64url');
    }

    newFamily(): string {
        return randomUUID();
    }

    fingerprintOf(token: string): string {
        return createHmac('sha256', this.pepper).update(token).digest('hex');
    }

    async issue(manager: EntityManager, token: string, row: NewRefresh): Promise<void> {
        await manager.query(
            `INSERT INTO refresh_tokens (token_hash, family_id, user_id, expires_at)
             VALUES ($1, $2, $3, $4)`,
            [this.fingerprintOf(token), row.familyId, row.userId, row.expiresAt],
        );
    }

    /**
     * Reads the row and holds it for the rest of the transaction.
     *
     * `FOR UPDATE` and not a plain SELECT: two refreshes of the same token arriving
     * together would otherwise both read `used_at IS NULL`, both rotate, and the session
     * would quietly fork. Under the lock the second one waits, sees the mark the first
     * wrote, and is correctly treated as a replay.
     */
    async claim(manager: EntityManager, token: string): Promise<StoredRefresh | null> {
        const rows = await manager.query<RefreshRow[]>(
            `SELECT id, family_id, user_id, used_at, revoked_at, expires_at
               FROM refresh_tokens
              WHERE token_hash = $1
                FOR UPDATE`,
            [this.fingerprintOf(token)],
        );

        const row = rows[0];

        return row === undefined
            ? null
            : {
                  id: row.id,
                  familyId: row.family_id,
                  userId: row.user_id,
                  usedAt: row.used_at,
                  revokedAt: row.revoked_at,
                  expiresAt: row.expires_at,
              };
    }

    async markUsed(manager: EntityManager, id: string): Promise<void> {
        await manager.query('UPDATE refresh_tokens SET used_at = now() WHERE id = $1', [id]);
    }

    /**
     * Kills every token descended from one login. The number it returns is what the
     * incident line reports — "two rows revoked" is the difference between a detection
     * that did something and a log message.
     */
    async revokeFamily(manager: EntityManager, familyId: string): Promise<number> {
        const rows = await manager.query<{ revoked: number }[]>(
            `WITH killed AS (
                 UPDATE refresh_tokens SET revoked_at = now()
                  WHERE family_id = $1 AND revoked_at IS NULL
                 RETURNING id
             )
             SELECT count(*)::int AS revoked FROM killed`,
            [familyId],
        );

        return rows[0]?.revoked ?? 0;
    }

    /** What `demo:reuse` prints: how many rows the family has, and how many still work. */
    async familyState(familyId: string): Promise<FamilyState> {
        const rows = await this.dataSource.query<FamilyState[]>(
            `SELECT count(*)::int AS rows,
                    count(*) FILTER (WHERE revoked_at IS NULL AND used_at IS NULL)::int AS live
               FROM refresh_tokens WHERE family_id = $1`,
            [familyId],
        );

        return rows[0] ?? { rows: 0, live: 0 };
    }
}
