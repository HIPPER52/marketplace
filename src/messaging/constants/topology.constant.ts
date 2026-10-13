/**
 * Every name and number the broker topology is made of.
 *
 * In one file because three processes declare or address the same topology — the
 * publisher inside checkout, the consumer, and each of the three demos — and a queue name
 * spelled slightly differently in one of them is not a compile error. It is a consumer
 * that waits forever on a queue nobody publishes to.
 */

/** The topic exchange every domain event of this service goes to. */
export const EVENTS_EXCHANGE = 'shop.events';

/**
 * Where an event that could not be processed ends up. A separate exchange rather than a
 * queue: dead-lettering republishes through an exchange, so the failure path is routed
 * the same way the happy path is, and a second kind of poison message later needs a
 * binding rather than a redesign.
 */
export const DEAD_LETTER_EXCHANGE = 'shop.events.dlx';

/** `order.placed`: the only event this assignment carries. */
export const ORDER_PLACED_TYPE = 'order.placed';

/**
 * The routing key is the event type, deliberately. A topic exchange matches on segments,
 * so `order.#` reaches everything about orders and `order.placed` reaches exactly this —
 * and nobody has to look up a table to know which key an event carries.
 */
export const ORDER_PLACED_KEY = ORDER_PLACED_TYPE;

export const ORDER_PLACED_QUEUE = 'shop.order-placed';

/** Its dead-letter queue. The failure contour is a queue of its own, not a bin. */
export const ORDER_PLACED_DLQ = 'shop.order-placed.dlq';

/**
 * Unacknowledged deliveries allowed per consumer.
 *
 * The broker's default is 0, and 0 means no limit: the first consumer to subscribe is
 * handed the whole queue and the second one idles. Measured on the stand —
 * `rabbitmqctl eval 'application:get_env(rabbit, default_consumer_prefetch).'` answers
 * `{ok,{false,0}}`.
 *
 * Ten, because the handler is one INSERT — about 5 ms against the pooler — and ten of
 * them in flight keeps the socket busy across the round trip without parking work on a
 * consumer that might die holding it. The safety check is prefetch x handler time <
 * consumer_timeout: 10 x 5 ms = 50 ms against a stock timeout of 30 minutes, four orders
 * of magnitude of headroom. prefetch=1 would be right if the handler took minutes; here
 * it would mean a round trip per message.
 */
export const PREFETCH = 10;

/**
 * How many times a quorum queue hands the same message out before dead-lettering it.
 *
 * This is what makes "the work can get stuck forever" a bounded failure instead of a
 * message that circles the queue heating the cluster. It only counts deliveries that were
 * returned with `basic.reject`: `nack` does not move the counter, which is why the
 * consumer rejects and never nacks — see OrderPlacedConsumer.
 */
export const DELIVERY_LIMIT = 3;
