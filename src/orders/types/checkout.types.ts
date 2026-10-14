import type { Currency } from '../../common/constants/currency.constant';

export interface CheckoutLine {
    productId: string;
    quantity: number;
}

export interface CheckoutRequest {
    userId: string;
    lines: CheckoutLine[];
    currency?: Currency;
}

/**
 * Every way checkout can end, as data rather than as an exception.
 *
 * "Out of stock" and "not enough money" are answers, not faults: the caller has to tell
 * the customer which one it was, and a thrown error would make the HTTP layer parse a
 * message to find out. Faults — a dead connection, a serialization failure — still throw.
 */
export type CheckoutResult =
    | {
          outcome: 'created';
          orderId: string;
          totalCents: number;
          jobId: string;
          /** When the order was written, ISO 8601 — what `order.placed` carries. */
          occurredAt: string;
      }
    | { outcome: 'unknown-product'; productId: string }
    | { outcome: 'out-of-stock'; productId: string; requested: number; available: number }
    | { outcome: 'insufficient-funds'; requiredCents: number; availableCents: number };
