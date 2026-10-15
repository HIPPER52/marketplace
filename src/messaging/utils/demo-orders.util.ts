import type { DataSource } from 'typeorm';
import type { CreateOrderRequest } from '../../common/types/api.types';
import { IdempotencyKeysRepository } from '../../orders/repositories/idempotency-keys.repository';
import { CheckoutService } from '../../orders/services/checkout.service';
import { IdempotencyRegistry } from '../../orders/services/idempotency.service';
import { PlaceOrderService } from '../../orders/services/place-order.service';
import { DEMO_PRODUCT_ID } from '../constants/demo.constant';
import { OutboxRepository } from '../repositories/outbox.repository';

/**
 * The order-placing use case, assembled by hand.
 *
 * Exactly what OrdersModule wires for `POST /orders` — the same three collaborators in the
 * same arrangement — because a demo that built a simpler path would be measuring a path
 * nobody deploys. It is assembled rather than reached over HTTP for a reason that belongs
 * to this repository: a grader exports `DATABASE_URL` with the password inline, and the
 * service's environment schema refuses exactly that by the decision taken in #13. The
 * demos cannot boot the HTTP layer, so they call what the handler calls.
 */
export function placeOrderService(dataSource: DataSource): PlaceOrderService {
    const idempotency = new IdempotencyRegistry(dataSource);
    const checkout = new CheckoutService(dataSource, new OutboxRepository(), idempotency.completer);

    return new PlaceOrderService(idempotency, checkout);
}

/** One unit of the demos' own product. */
export function oneItemOrder(quantity = 1): CreateOrderRequest {
    return { items: [{ product_id: DEMO_PRODUCT_ID, quantity }] };
}

export { IdempotencyKeysRepository };
