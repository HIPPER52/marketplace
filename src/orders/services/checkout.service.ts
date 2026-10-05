import type { DataSource, EntityManager } from 'typeorm';
import { Currency } from '../../common/constants/currency.constant';
import { withRetry } from '../../database/utils/with-retry.util';
import { JobKind } from '../../jobs/constants/job-status.constant';
import { Job } from '../../jobs/entities/job.entity';
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
 */
export class CheckoutService {
    constructor(private readonly dataSource: DataSource) {}

    async checkout(request: CheckoutRequest): Promise<CheckoutResult> {
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

        return { outcome: 'created', orderId: order.id, totalCents, jobId: job.id };
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
