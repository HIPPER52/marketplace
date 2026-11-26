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

/** How many orders keep a replay buffer; the least recently written is dropped first. */
const ORDERS_BUFFERED = 1_000;

/**
 * How many orders keep their counter. Far more than keep a buffer, because the two
 * things cost differently — a buffer is a hundred objects, a counter is one number — and
 * because losing a counter is the worse failure of the two.
 *
 * Losing a buffer costs a replay: the client gets no history and carries on live. Losing
 * a counter restarts numbering at 1, and then a client holding `Last-Event-ID: 50` filters
 * out every event this order will ever emit again. It would look like a dead stream and
 * nothing in the logs would say why.
 */
const ORDERS_NUMBERED = 100_000;

@Injectable()
export class OrderEventsService {
    private readonly stream = new Subject<OrderEvent>();
    private readonly history = new Map<string, OrderEvent[]>();
    private readonly sequences = new Map<string, number>();

    /**
     * Records a change and tells every watcher. Called by the service that wrote the
     * status, never by a controller: a caller that forgot to publish would be an order
     * whose watchers are silently a version behind.
     */
    publish(orderId: string, status: OrderStatus): OrderEvent {
        // The number comes from its own map, never from the tail of the buffer. Reading
        // it off the buffer would mean that evicting the buffer silently restarts the
        // sequence at 1 — see ORDERS_NUMBERED.
        const id = (this.sequences.get(orderId) ?? 0) + 1;

        const event: OrderEvent = { id, orderId, status, at: new Date().toISOString() };

        const past = this.history.get(orderId) ?? [];
        past.push(event);

        if (past.length > EVENTS_PER_ORDER) {
            past.splice(0, past.length - EVENTS_PER_ORDER);
        }

        // Re-inserting moves the key to the end of each Map's insertion order, which is
        // what makes the evictions below least-recently-written rather than oldest-ever.
        this.history.delete(orderId);
        this.history.set(orderId, past);
        this.sequences.delete(orderId);
        this.sequences.set(orderId, id);

        evictTo(this.history, ORDERS_BUFFERED);
        evictTo(this.sequences, ORDERS_NUMBERED);

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

/** Drops least-recently-written keys until the map is within its cap. */
function evictTo(map: Map<string, unknown>, cap: number): void {
    while (map.size > cap) {
        const oldest = map.keys().next();

        if (oldest.done === true) {
            return;
        }

        map.delete(oldest.value);
    }
}
