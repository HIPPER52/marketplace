import { Role } from '../../auth/constants/role.constant';

/**
 * The accounts the demos sign in as.
 *
 * ## Why a buyer id is still a constant
 *
 * `POST /orders` now debits whoever presented the token, so nothing in the HTTP path
 * names an account any more. The CLI demos still do: `demo:outbox`, `demo:duplicate`,
 * `demo:race` and the rest call `CheckoutService` directly, below the layer that knows
 * about tokens, and a transaction that moves money has to name the account it moves it
 * from. That is what `DEMO_BUYER_ID` is for, and it is the only thing left it is for.
 *
 * ## Why the password is here and not in a migration
 *
 * `password_hash` is nullable and the rows that predate authentication have none —
 * a migration that invented one would write a credential into this repository's history,
 * and every deployment that ran it would share the same live account. The demos create
 * their own instead, at runtime, against the stand in front of them: see
 * `src/users/utils/demo-account.util.ts`. The value below is a *demo* credential for a
 * local stand, named as such, and nothing the service ships depends on it.
 */
export const DEMO_BUYER_ID = '1';

export const DEMO_BUYER_EMAIL = 'buyer@marketplace.local';

/**
 * Enough to place an order without the balance being the thing under test. Checkout
 * debits it for real, so a long-running stand eventually runs out — that is the honest
 * behaviour, not a bug to paper over.
 */
export const DEMO_BUYER_BALANCE_CENTS = 100_000_000;

export const DEMO_SELLER_EMAIL = 'seller@marketplace.local';
export const DEMO_ADMIN_EMAIL = 'admin@marketplace.local';

/** The one the demos and the README use. A local stand's credential, not a secret. */
export const DEMO_PASSWORD = 'demo-password';

/** Who each demo address is, so a demo and the README cannot disagree about it. */
export const DEMO_ACCOUNTS = [
    {
        email: DEMO_BUYER_EMAIL,
        displayName: 'Demo buyer',
        role: Role.Customer,
        balanceCents: DEMO_BUYER_BALANCE_CENTS,
    },
    {
        email: DEMO_SELLER_EMAIL,
        displayName: 'Demo seller',
        role: Role.Seller,
        balanceCents: 0,
    },
    {
        email: DEMO_ADMIN_EMAIL,
        displayName: 'Demo admin',
        role: Role.Admin,
        balanceCents: 0,
    },
] as const;

export type DemoAccount = (typeof DEMO_ACCOUNTS)[number];
