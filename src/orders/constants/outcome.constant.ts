/**
 * How placing an order can end, named.
 *
 * Three vocabularies, one per layer of the same request, kept together because that is how
 * they are read — follow `POST /orders` down and you meet all three in order:
 *
 *   `KeyClaimOutcome`     what the idempotency reservation said
 *   `CheckoutOutcome`     what the transaction decided
 *   `PlaceOrderOutcome`   what the use case answers the route with
 *
 * They are the discriminants of discriminated unions, which is exactly why they need
 * names. A tag is a domain concept that happens to be stored as a string, and an inline
 * `'created'` has every weakness a bare literal has: "go to references" cannot find it, a
 * typo in one of five copies still compiles — `result.outcome === 'creted'` is simply
 * `false` forever, with no error anywhere — and renaming the concept means grepping and
 * hoping. The compiler catches all three the moment the value has a name.
 *
 * `as const` objects rather than `enum`, for the reasons in CLAUDE.md: `enum` emits runtime
 * code, numeric enums accept any number, and `const enum` breaks under `isolatedModules`.
 * The union type comes free from the object, so the discriminated unions below stay
 * narrowable — `outcome: typeof CheckoutOutcome.Created` is the literal `'created'`.
 */

/** What `IdempotencyKeysRepository.claim` found. */
export const KeyClaimOutcome = {
    /** The key is ours; nothing with it has run before. */
    Claimed: 'claimed',
    /** It already names an order. Hand that order back. */
    Replay: 'replay',
    /** Same key, different body — a client bug, not a retry. */
    Conflict: 'conflict',
    /** Reserved, and the request that reserved it has not finished. */
    InFlight: 'in-flight',
} as const;

export type KeyClaimOutcome = (typeof KeyClaimOutcome)[keyof typeof KeyClaimOutcome];

/**
 * How the checkout transaction ended.
 *
 * Every one of these is an answer rather than a fault: the caller has to tell the customer
 * which it was, and a thrown error would make the HTTP layer parse a message to find out.
 */
export const CheckoutOutcome = {
    Created: 'created',
    UnknownProduct: 'unknown-product',
    OutOfStock: 'out-of-stock',
    InsufficientFunds: 'insufficient-funds',
} as const;

export type CheckoutOutcome = (typeof CheckoutOutcome)[keyof typeof CheckoutOutcome];

/** What the use case answers the route with. */
export const PlaceOrderOutcome = {
    Created: 'created',
    /** The same key already placed this order; the answer is the original one. */
    Replayed: 'replayed',
    Conflict: 'conflict',
    InFlight: 'in-flight',
    /** Checkout refused — out of stock, no such product, not enough money. */
    Refused: 'refused',
} as const;

export type PlaceOrderOutcome = (typeof PlaceOrderOutcome)[keyof typeof PlaceOrderOutcome];
