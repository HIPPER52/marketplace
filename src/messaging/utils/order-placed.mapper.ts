import type { Currency } from '../../common/constants/currency.constant';
import { AggregateType } from '../constants/outbox.constant';
import { ORDER_PLACED_TYPE } from '../constants/topology.constant';
import type { OrderPlacedEvent } from '../types/order-placed.types';
import type { NewOutboxRecord } from '../types/outbox.types';

export interface OrderPlacedFacts {
    orderId: string;
    userId: string;
    totalCents: number;
    currency: Currency;
    /** ISO 8601. When the order was placed, not when the row is carried out. */
    occurredAt: string;
}

/**
 * An explicit function, not a spread of the entity.
 *
 * `{ ...order }` in a payload publishes the database schema as a public API: every column
 * becomes a promise to whoever is listening, and the first renamed column breaks every
 * consumer at once — including the ones whose code nobody here can see. Three lines of
 * mapping now is the contract surviving the next migration.
 *
 * It also decides what is *not* sent. `status` is absent because the event already says
 * the order was placed; the relation ids are absent because they exist for this service's
 * own joins. A field added here is a field that can never be removed quietly.
 */
export function toOrderPlacedEvent(eventId: string, facts: OrderPlacedFacts): OrderPlacedEvent {
    return {
        eventId,
        type: ORDER_PLACED_TYPE,
        occurredAt: facts.occurredAt,
        data: {
            orderId: facts.orderId,
            userId: facts.userId,
            totalCents: facts.totalCents,
            currency: facts.currency,
        },
    };
}

/**
 * The row that carries it. `aggregate_id` is the order, which makes it the partitioning
 * key — whatever ordering exists downstream exists within one order and nowhere else.
 */
export function toOutboxRecord(event: OrderPlacedEvent): NewOutboxRecord {
    return {
        id: event.eventId,
        aggregateType: AggregateType.Order,
        aggregateId: event.data.orderId,
        type: event.type,
        payload: event as unknown as Record<string, unknown>,
    };
}
