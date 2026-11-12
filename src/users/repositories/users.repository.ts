import { Inject, Injectable } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import type { Role } from '../../auth/constants/role.constant';
import { DATA_SOURCE } from '../../database/constants/database.constants';

/** The row as Postgres hands it back. `one` maps it to the camelCase `Account`. */
interface AccountRow {
    id: string;
    email: string;
    display_name: string;
    role: Role;
    password_hash: string | null;
}

export interface Account {
    id: string;
    email: string;
    displayName: string;
    role: Role;
    passwordHash: string | null;
}

@Injectable()
export class UsersRepository {
    constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}

    /**
     * Matched on `lower(email)`, because that is the unique index — `A@x.com` and
     * `a@x.com` are one account, and a login that matched exactly would let somebody
     * create a second one by shifting a capital.
     */
    byEmail(email: string): Promise<Account | null> {
        return this.one('lower(email) = lower($1)', email);
    }

    /**
     * The role read here is the one every decision uses. The copy inside an access token
     * is a hint for a UI; this is the fact.
     */
    byId(id: string): Promise<Account | null> {
        return this.one('id = $1', id);
    }

    private async one(predicate: string, parameter: string): Promise<Account | null> {
        const rows = await this.dataSource.query<AccountRow[]>(
            `SELECT id, email, display_name, role, password_hash
               FROM users WHERE ${predicate} LIMIT 1`,
            [parameter],
        );

        const row = rows[0];

        return row === undefined
            ? null
            : {
                  id: row.id,
                  email: row.email,
                  displayName: row.display_name,
                  role: row.role,
                  passwordHash: row.password_hash,
              };
    }
}
