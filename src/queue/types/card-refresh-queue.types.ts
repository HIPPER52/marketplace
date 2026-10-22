/**
 * The one thing the order path needs from the queue.
 *
 * An interface and a token rather than the class, for the reason `OutboxWriter` is one:
 * it is a seam. Production passes `CardQueue`; the messaging demos, which are about a
 * broker and have no Redis, pass something that does nothing — and neither of them has to
 * know about the other.
 */
export interface CardRefreshQueue {
    refresh(productId: string): Promise<void>;
}

export const CARD_REFRESH_QUEUE = Symbol('CARD_REFRESH_QUEUE');

/** For callers that place orders without a queue behind them. */
export const noCardRefreshQueue: CardRefreshQueue = {
    refresh: () => Promise.resolve(),
};
