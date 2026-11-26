import { hash } from '@node-rs/argon2';
import type { DataSource } from 'typeorm';
import type { Role } from '../../auth/constants/role.constant';
import {
    DEMO_ACCOUNTS,
    DEMO_PASSWORD,
    type DemoAccount,
} from '../constants/demo-accounts.constant';

export interface SeededAccount {
    id: string;
    email: string;
    role: Role;
}

/**
 * Brings the demo accounts into existence, with a password, against whatever stand is in
 * front of us.
 *
 * Deliberately **not** a migration. A migration that inserted a password hash would ship
 * a live credential in this repository's history, identical on every deployment that ever
 * ran it; `AuthTokens1793291335084` leaves `password_hash` nullable for exactly that
 * reason. A demo that needs to sign in creates what it needs, here, and says so.
 *
 * Idempotent: re-running rewrites the hash — a new salt every time, so two runs produce
 * two different strings for one password, which is argon2id doing its job rather than a
 * sign the write did not take.
 */
export async function seedDemoAccounts(
    dataSource: DataSource,
    password: string = DEMO_PASSWORD,
): Promise<SeededAccount[]> {
    const seeded: SeededAccount[] = [];

    for (const account of DEMO_ACCOUNTS) {
        seeded.push(await seedDemoAccount(dataSource, account, password));
    }

    return seeded;
}

export async function seedDemoAccount(
    dataSource: DataSource,
    account: DemoAccount,
    password: string = DEMO_PASSWORD,
): Promise<SeededAccount> {
    const passwordHash = await hash(password);

    const rows = await dataSource.query<{ id: string; email: string; role: Role }[]>(
        `INSERT INTO users (email, display_name, balance_cents, password_hash, role)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (lower(email)) DO UPDATE
             SET password_hash = EXCLUDED.password_hash,
                 role          = EXCLUDED.role,
                 balance_cents = GREATEST(users.balance_cents, EXCLUDED.balance_cents)
         RETURNING id, email, role`,
        [account.email, account.displayName, account.balanceCents, passwordHash, account.role],
    );

    const row = rows[0];

    if (row === undefined) {
        throw new Error(`Could not seed the demo account ${account.email}.`);
    }

    return row;
}
