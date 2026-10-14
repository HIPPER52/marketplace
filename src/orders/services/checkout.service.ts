import { Logger } from '@nestjs/common';
import type { DataSource, EntityManager } from 'typeorm';
import { Currency } from '../../common/constants/currency.constant';
import { withRetry } from '../../database/utils/with-retry.util';
import { JobKind } from '../../jobs/constants/job-status.constant';
import { Job } from '../../jobs/entities/job.entity';
import { ORDER_PLACED_TYPE } from '../../messaging/constants/topology.constant';
import type { OrderEventPublisher } from '../../messaging/services/order-event-publisher.service';
import type { OrderPlacedEvent } from '../../messaging/types/order-placed.types';
import { deterministicEventId } from '../../messaging/utils/event-id.util';
import type { User } from '../../users/entities/user.entity';
import { OrderStatus } from '../constants/order-status.constant';
import { Order } from '../entities/order.entity';
import { OrderItem } from '../entities/order-item.entity';
import type { CheckoutRequest, CheckoutResult } from '../types/checkout.types';

/**
 * Placing an order: decrement stock, debit the buyer, write the order and its line items,
 * queue the receipt — all of it, or none of it.
 *
 * ## Why an atomic UPDATE and not SELECT … FOR UPDATE
 *
 * Both close the race. The difference is where the decision lives.
 *
 *     UPDATE products SET in_stock = in_stock - $2
 *      WHERE id = $1 AND in_stock >= $2
 *      RETURNING price_cents, currency
 *
 * That single statement is the check and the write at once, so the window between reading
 * a number and acting on it does not exist — not a short window, none. A concurrent
 * checkout blocks on the row lock, and when it resumes READ COMMITTED re-evaluates the
 * `WHERE` against the version that just committed. Zero rows back means "not any more",
 * decided by the database on current data rather than by this process on a stale read.
 *
 * `SELECT … FOR UPDATE` would also work and reads more obviously — lock, think, write. It
 * costs an extra round trip and holds the lock across it, and it tempts the next person to
 * put application logic between the two statements, which is exactly the shape that lost
 * the 50 грн in the lecture.
 *
 * What the atomic form gives up: zero rows is one answer to two questions. "No such
 * product" and "not enough of it" are distinguished by a second query — but only on the
 * failure path, where an extra read costs nothing.
 *
 * ## Why this cannot oversell even if the above is wrong
 *
 * `products.in_stock` carries `CHECK (in_stock >= 0)` and `users.balance_cents` carries
 * `CHECK (balance_cents >= 0)`. If the predicate above were ever mistaken, Postgres
 * answers 23514 and the transaction rolls back. The invariant is held by the schema; the
 * query is merely how it is held efficiently.
 *
 * ## Lock order
 *
 * Line items are sorted by product id, and products are always touched before the buyer.
 * Two checkouts therefore take their locks in the same order and cannot form a cycle —
 * deadlock prevention is cheaper than deadlock recovery. `withRetry` still wraps the
 * transaction, because "cheaper" is not "guaranteed" once other writers exist.
 *
 * ## Why `order.placed` is published here and not in the controller
 *
 * The event leaves the business operation, so it leaves whether the order came from
 * `POST /orders`, from a demo script, or from whatever calls checkout next. A route that
 * published would make the announcement a property of one entry point — the same mistake
 * #18 avoided by putting the realtime emit in OrderStatusService rather than in a handler.
 *
 * ## Why after the transaction, and what that costs
 *
 * A broker cannot join a Postgres transaction. Publishing inside it would announce an
 * order that a later 40001 rolled back; publishing after it leaves a window in which the
 * order exists and nobody was told. Neither is free, and the second is the one that can be
 * repaired afterwards — `jobs` already carries, in the same transaction, the work that
 * genuinely must not be lost. The real fix is a transactional outbox: the event written as
 * a row beside the order, a separate process publishing it. That is #22, and until then
 * this gap is named rather than hidden.
 */
export class CheckoutService {
    private readonly logger = new Logger(CheckoutService.name);

    constructor(
        private readonly dataSource: DataSource,
        /** Null when no broker is configured — see MessagingModule. */
        private readonly publisher: OrderEventPublisher | null = null,
    ) {}

    async checkout(request: CheckoutRequest): Promise<CheckoutResult> {
        const result = await this.attempt(request);

        if (result.outcome === 'created') {
            await this.announce(result, request);
        }

        return result;
    }

    private async attempt(request: CheckoutRequest): Promise<CheckoutResult> {
        try {
            return await withRetry(this.dataSource, { label: 'checkout' }, (manager) =>
                this.run(manager, request),
            );
        } catch (error: unknown) {
            if (error instanceof CheckoutAbort) {
                return error.result;
            }

            throw error;
        }
    }

    /**
     * The order is committed by the time this runs, so a broker that is unreachable must
     * not turn a placed order into a failed request. The failure is logged and the customer
     * is answered — and the window itself is what #22's outbox removes.
     */
    private async announce(
        result: Extract<CheckoutResult, { outcome: 'created' }>,
        request: CheckoutRequest,
    ): Promise<void> {
        if (this.publisher === null) {
            return;
        }

        const event: OrderPlacedEvent = {
            // Derived from the order, so a republish after a lost confirm carries the id
            // the first attempt carried.
            eventId: deterministicEventId(ORDER_PLACED_TYPE, result.orderId),
            type: ORDER_PLACED_TYPE,
            occurredAt: result.occurredAt,
            data: {
                orderId: result.orderId,
                userId: request.userId,
                totalCents: result.totalCents,
                currency: request.currency ?? Currency.UAH,
            },
        };

        try {
            await this.publisher.publishOrderPlaced(event);
        } catch (error: unknown) {
            this.logger.error(
                `order ${result.orderId} was placed but ${ORDER_PLACED_TYPE} was not ` +
                    `published: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }

    private async run(manager: EntityManager, request: CheckoutRequest): Promise<CheckoutResult> {
        const currency = request.currency ?? Currency.UAH;
        const lines = [...request.lines].sort((left, right) =>
            left.productId.localeCompare(right.productId),
        );

        const items: OrderItem[] = [];
        let totalCents = 0;

        for (const line of lines) {
            // TypeORM returns [rows, affectedCount] for UPDATE and DELETE and a bare rows
            // array for everything else, so a RETURNING clause does not come back the shape
            // a SELECT does. Destructuring the tuple is the difference between reading the
            // row and reading the array that holds it.
            const [claimed] = await manager.query<
                [{ price_cents: string; currency: Currency }[], number]
            >(
                `UPDATE products SET in_stock = in_stock - $2
                  WHERE id = $1 AND in_stock >= $2
                  RETURNING price_cents, currency`,
                [line.productId, line.quantity],
            );

            const product = claimed[0];

            if (product === undefined) {
                throw new CheckoutAbort(await explainStockFailure(manager, line));
            }

            if (product.currency !== currency) {
                throw new CheckoutAbort({ outcome: 'unknown-product', productId: line.productId });
            }

            const unitPriceCents = Number(product.price_cents);
            const subtotalCents = unitPriceCents * line.quantity;
            totalCents += subtotalCents;

            const item = new OrderItem();
            item.product = { id: line.productId } as OrderItem['product'];
            item.quantity = line.quantity;
            item.unitPriceCents = unitPriceCents;
            item.subtotalCents = subtotalCents;
            items.push(item);
        }

        const [debited] = await manager.query<[{ balance_cents: string }[], number]>(
            `UPDATE users SET balance_cents = balance_cents - $2
              WHERE id = $1 AND balance_cents >= $2
              RETURNING balance_cents`,
            [request.userId, totalCents],
        );

        if (debited[0] === undefined) {
            throw new CheckoutAbort(await explainFundsFailure(manager, request.userId, totalCents));
        }

        // Read before the write rather than from the saved row: `created_at` is a column
        // default, and whether an INSERT hands defaults back depends on how TypeORM built
        // the statement. The difference is a millisecond; the ambiguity is not worth it.
        const occurredAt = new Date().toISOString();

        const order = new Order();
        order.user = { id: request.userId } as User;
        order.status = OrderStatus.Pending;
        order.currency = currency;
        order.totalCents = totalCents;
        order.items = items;
        await manager.save(order);

        // Queued in the same transaction as the order it is about. A broker could not join
        // this transaction, which is why "the order exists but nobody was told" is a class
        // of bug that only a queue table can rule out. #19 turns this into a real outbox.
        const job = new Job();
        job.kind = JobKind.OrderReceipt;
        job.order = { id: order.id } as Order;
        job.payload = { orderId: order.id, totalCents, currency };
        await manager.save(job);

        return { outcome: 'created', orderId: order.id, totalCents, jobId: job.id, occurredAt };
    }
}

/** Thrown to roll the transaction back; carries the answer the caller gets instead. */
class CheckoutAbort extends Error {
    constructor(readonly result: CheckoutResult) {
        super(result.outcome);
        this.name = 'CheckoutAbort';
    }
}

/** Only ever called after the UPDATE returned nothing, so an extra read is free. */
async function explainStockFailure(
    manager: EntityManager,
    line: { productId: string; quantity: number },
): Promise<CheckoutResult> {
    const rows = await manager.query<{ in_stock: number }[]>(
        'SELECT in_stock FROM products WHERE id = $1',
        [line.productId],
    );
    const product = rows[0];

    return product === undefined
        ? { outcome: 'unknown-product', productId: line.productId }
        : {
              outcome: 'out-of-stock',
              productId: line.productId,
              requested: line.quantity,
              available: Number(product.in_stock),
          };
}

async function explainFundsFailure(
    manager: EntityManager,
    userId: string,
    requiredCents: number,
): Promise<CheckoutResult> {
    const rows = await manager.query<{ balance_cents: string }[]>(
        'SELECT balance_cents FROM users WHERE id = $1',
        [userId],
    );

    return {
        outcome: 'insufficient-funds',
        requiredCents,
        availableCents: Number(rows[0]?.balance_cents ?? 0),
    };
}
