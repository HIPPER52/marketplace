import { Injectable } from '@nestjs/common';
import { filter, type Observable, Subject } from 'rxjs';
import type { OrderStatus } from '../constants/order-status.constant';
import type { OrderEvent } from '../types/order-event.types';

/**
 * One bus, two transports.
 *
 * The WebSocket gateway and the SSE endpoint are two ways of watching the same thing, so
 * they must not each keep their own idea of what happened. The bus is a provider rather
 * than state inside the gateway for exactly that reason: the HTTP controller can inject
 * it without knowing a gateway exists.
 *
 * ## What the buffer is for, and what it is not
 *
 * `Last-Event-ID` is a promise that a dropped connection costs no events, and a promise
 * needs somewhere to keep them. This buffer is in the process: it does not survive a
 * restart and it is not shared between instances. Both limits are real and are stated in
 * the README rather than discovered. #19 replaces this with a queue that does survive.
 */

/** Per order. Enough to cover a reconnect, not enough to be a store. */
const EVENTS_PER_ORDER = 100;

/** How many orders are remembered at once; the oldest is dropped first. */
const ORDERS_REMEMBERED = 1_000;

@Injectable()
export class OrderEventsService {
    private readonly stream = new Subject<OrderEvent>();
    private readonly history = new Map<string, OrderEvent[]>();

    /**
     * Records a change and tells every watcher. Called by the service that wrote the
     * status, never by a controller: a caller that forgot to publish would be an order
     * whose watchers are silently a version behind.
     */
    publish(orderId: string, status: OrderStatus): OrderEvent {
        const past = this.history.get(orderId) ?? [];

        const event: OrderEvent = {
            id: (past.at(-1)?.id ?? 0) + 1,
            orderId,
            status,
            at: new Date().toISOString(),
        };

        past.push(event);

        if (past.length > EVENTS_PER_ORDER) {
            past.splice(0, past.length - EVENTS_PER_ORDER);
        }

        // Re-inserting moves the key to the end of the Map's insertion order, which is
        // what makes the eviction below least-recently-written rather than oldest-ever.
        this.history.delete(orderId);
        this.history.set(orderId, past);

        while (this.history.size > ORDERS_REMEMBERED) {
            const oldest = this.history.keys().next();

            if (oldest.done === true) {
                break;
            }

            this.history.delete(oldest.value);
        }

        this.stream.next(event);

        return event;
    }

    /** Everything this order has done since `lastEventId`, oldest first. */
    since(orderId: string, lastEventId: number): OrderEvent[] {
        return (this.history.get(orderId) ?? []).filter((event) => event.id > lastEventId);
    }

    /** Live changes for one order. */
    forOrder(orderId: string): Observable<OrderEvent> {
        return this.stream.asObservable().pipe(filter((event) => event.orderId === orderId));
    }

    /** Live changes for every order — what the gateway fans out into rooms. */
    all(): Observable<OrderEvent> {
        return this.stream.asObservable();
    }
}
