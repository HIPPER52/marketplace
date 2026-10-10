/**
 * Who is buying, until there is a way to ask.
 *
 * `POST /orders` has to debit someone, and nothing in this project authenticates anyone:
 * the contract from #09 describes no customer resource and carries no credentials, and
 * the assignment that adds authentication has not happened yet. Inventing a header or a
 * `buyer_id` field would put a second, undocumented source of truth next to openapi.yaml
 * — exactly what the contract-first rule exists to prevent.
 *
 * So checkout debits one deterministic account, created by its own migration. The id is
 * a literal here because this is where the concept is defined; everywhere else it is this
 * name. When authentication lands, this constant is the single place that stops being
 * right, and the compiler will say where it was read.
 */
export const DEMO_BUYER_ID = '1';

export const DEMO_BUYER_EMAIL = 'buyer@marketplace.local';

/**
 * Enough to place an order without the balance being the thing under test. Checkout
 * debits it for real, so a long-running stand eventually runs out — that is the honest
 * behaviour, not a bug to paper over.
 */
export const DEMO_BUYER_BALANCE_CENTS = 100_000_000;
