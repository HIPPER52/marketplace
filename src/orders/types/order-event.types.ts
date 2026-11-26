import type { OrderStatus } from '../constants/order-status.constant';

/**
 * One status change, as it travels inside the process.
 *
 * `id` counts within its own order, starting at 1 — not across all orders. A client
 * reconnecting to `/orders/{id}/events` sends back the last id it saw, and that number
 * has to mean something for this order alone; a global counter would make the sequence
 * a client sees full of holes it cannot distinguish from lost events.
 */
export interface OrderEvent {
    id: number;
    orderId: string;
    status: OrderStatus;
    at: string;
}

/** What a subscriber receives, over either transport. The wire shape is snake_case. */
export interface OrderEventPayload {
    id: number;
    order_id: string;
    status: OrderStatus;
    at: string;
}

export function toPayload(event: OrderEvent): OrderEventPayload {
    return {
        id: event.id,
        order_id: event.orderId,
        status: event.status,
        at: event.at,
    };
}
