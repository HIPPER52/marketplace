import type { Currency } from '../../common/constants/currency.constant';
import type { ORDER_PLACED_TYPE } from '../constants/topology.constant';

/**
 * What goes on the wire when an order is placed.
 *
 * A designed contract, not an entity through a spread. An `Order` row carries columns
 * that exist for this service's own reasons — `status`, `created_at`, the relation ids —
 * and publishing it would make every one of them a promise to whoever is listening. The
 * envelope below is the promise, and it is four fields long.
 *
 * `eventId` is derived from the order rather than drawn at random, so a republish after a
 * lost confirm carries the id the first attempt carried. A consumer that deduplicates by
 * event id therefore recognises it; this one deduplicates by the order instead — see
 * OrderPlacedConsumer — and the stable id is what makes the two agree.
 */
export interface OrderPlacedEvent {
    eventId: string;
    type: typeof ORDER_PLACED_TYPE;
    /** ISO 8601, UTC. When the order was placed, not when the message was published. */
    occurredAt: string;
    data: {
        orderId: string;
        userId: string;
        totalCents: number;
        currency: Currency;
    };
}
