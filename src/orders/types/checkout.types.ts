import type { Currency } from '../../common/constants/currency.constant';
import type { CheckoutOutcome } from '../constants/outcome.constant';

export interface CheckoutLine {
    productId: string;
    quantity: number;
}

export interface CheckoutRequest {
    userId: string;
    lines: CheckoutLine[];
    currency?: Currency;
    /**
     * The reservation taken at the API edge, completed inside this operation's own
     * transaction. Absent for callers that did not come through an HTTP request.
     */
    idempotencyKey?: string;
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
          outcome: typeof CheckoutOutcome.Created;
          orderId: string;
          totalCents: number;
          jobId: string;
          /** When the order was written, ISO 8601 — what `order.placed` carries. */
          occurredAt: string;
          /** The outbox row's id, which is also the event id the consumer deduplicates by. */
          eventId: string;
      }
    | { outcome: typeof CheckoutOutcome.UnknownProduct; productId: string }
    | {
          outcome: typeof CheckoutOutcome.OutOfStock;
          productId: string;
          requested: number;
          available: number;
      }
    | {
          outcome: typeof CheckoutOutcome.InsufficientFunds;
          requiredCents: number;
          availableCents: number;
      };
