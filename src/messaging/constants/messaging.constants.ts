/**
 * The injection token for the publisher.
 *
 * A token rather than the class, because the provider's value is legitimately `null` when
 * no broker is configured, and a class used as a token promises an instance.
 */
export const ORDER_EVENT_PUBLISHER = Symbol('ORDER_EVENT_PUBLISHER');
