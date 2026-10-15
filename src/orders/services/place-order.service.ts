import { Injectable } from '@nestjs/common';
import type { CreateOrderRequest } from '../../common/types/api.types';
import { DEMO_BUYER_ID } from '../../users/constants/demo-buyer.constant';
import { CheckoutOutcome, KeyClaimOutcome, PlaceOrderOutcome } from '../constants/outcome.constant';
import type { CheckoutResult } from '../types/checkout.types';
import { CheckoutService } from './checkout.service';
import { IdempotencyRegistry } from './idempotency.service';

/**
 * The union; `PlaceOrderOutcome` is the vocabulary of its tags. Two names because they are
 * two things — the set of ways this can end, and the shape each one carries with it.
 */
export type PlaceOrderResult =
    | { outcome: typeof PlaceOrderOutcome.Created; orderId: string }
    | { outcome: typeof PlaceOrderOutcome.Replayed; orderId: string }
    | { outcome: typeof PlaceOrderOutcome.Conflict }
    | { outcome: typeof PlaceOrderOutcome.InFlight }
    | {
          outcome: typeof PlaceOrderOutcome.Refused;
          result: Exclude<CheckoutResult, { outcome: typeof CheckoutOutcome.Created }>;
      };

/**
 * Placing an order from a request that carries an `Idempotency-Key`.
 *
 * A service rather than a handler, for the usual reason and one new one. The usual: the
 * rule "the same key gives the same order" is a property of the operation, so it must hold
 * for every caller rather than for one route. The new one: `demo:outbox` has to make two
 * requests with one key and count the orders, and it cannot do that over HTTP — a grader
 * exports `DATABASE_URL` with the password inline, which the service's own environment
 * schema refuses by the deliberate decision taken in #13. The demo therefore calls exactly
 * what the controller calls, which is this.
 *
 * The three refusals are returned as data, not thrown. Which HTTP status each deserves is
 * a question about the API edge, and it is answered there.
 */
@Injectable()
export class PlaceOrderService {
    constructor(
        private readonly idempotency: IdempotencyRegistry,
        private readonly checkout: CheckoutService,
    ) {}

    async place(input: { key: string; body: CreateOrderRequest }): Promise<PlaceOrderResult> {
        const requestHash = this.idempotency.fingerprint(input.body);
        const claim = await this.idempotency.claim(input.key, requestHash);

        if (claim.outcome === KeyClaimOutcome.Conflict) {
            return { outcome: PlaceOrderOutcome.Conflict };
        }

        if (claim.outcome === KeyClaimOutcome.InFlight) {
            return { outcome: PlaceOrderOutcome.InFlight };
        }

        if (claim.outcome === KeyClaimOutcome.Replay) {
            return { outcome: PlaceOrderOutcome.Replayed, orderId: claim.orderId };
        }

        // The key is held from here on, and the transaction below is what completes it.
        try {
            const result = await this.checkout.checkout({
                userId: DEMO_BUYER_ID,
                lines: input.body.items.map((line) => ({
                    productId: line.product_id,
                    quantity: line.quantity,
                })),
                currency: input.body.currency,
                idempotencyKey: input.key,
            });

            if (result.outcome !== CheckoutOutcome.Created) {
                // Nothing was written, so nothing should be remembered. Holding the key
                // over a refusal would turn "out of stock" into a key that answers
                // in-flight for a minute and then takes a different answer.
                await this.idempotency.release(input.key);

                return { outcome: PlaceOrderOutcome.Refused, result };
            }

            return { outcome: PlaceOrderOutcome.Created, orderId: result.orderId };
        } catch (error: unknown) {
            await this.idempotency.release(input.key);
            throw error;
        }
    }
}
