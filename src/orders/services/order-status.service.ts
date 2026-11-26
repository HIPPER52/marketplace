import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Role } from '../../auth/constants/role.constant';
import type { Principal } from '../../auth/types/auth.types';
import { ProblemError, ProblemType } from '../../common/errors/problem.error';
import { DATA_SOURCE } from '../../database/constants/database.constants';
import { OrderStatus } from '../constants/order-status.constant';
import type { Order } from '../entities/order.entity';
import { OrdersRepository } from '../repositories/orders.repository';
import { OrderEventsService } from './order-events.service';

/**
 * Moving an order through its lifecycle — and telling everyone watching.
 *
 * The publish lives here rather than in the controller on purpose. A controller that
 * emitted would make the notification a property of one route: the first background job
 * or queue consumer that changes a status would do it silently, and nobody would notice
 * until a customer asked why the page stopped updating. The rule is that whatever writes
 * the status announces it, and there is one place that writes it.
 *
 * What this deliberately does not do is make the two atomic. The write is in Postgres,
 * the announcement is in memory; a process that dies between them loses the event, and
 * the watcher finds out on its next reconnect, from the buffer or from a plain GET. The
 * fix is an outbox, which is #19's subject — the `jobs` table from #14 is already the
 * shape it takes.
 */
@Injectable()
export class OrderStatusService {
    constructor(
        @Inject(DATA_SOURCE) private readonly dataSource: DataSource,
        private readonly orders: OrdersRepository,
        private readonly events: OrderEventsService,
    ) {}

    /**
     * `actor` is optional because this service has two kinds of caller. Over HTTP it is
     * the authenticated principal and the order has to be theirs; a queue consumer or a
     * CLI demo moving a status has no principal at all, and inventing one for it would
     * mean inventing an account with permission to do anything — which is worse than
     * saying plainly that the check belongs to the edge.
     */
    async changeStatus(orderId: string, status: OrderStatus, actor?: Principal): Promise<Order> {
        const existing = await this.orders.findById(orderId);

        if (existing === null) {
            throw new ProblemError({
                status: 404,
                type: ProblemType.notFound,
                title: 'Resource not found',
                detail: `No order with id ${orderId}.`,
            });
        }

        // Ownership, checked here rather than in a guard: a guard runs before anything is
        // loaded, so it would have to fetch the order itself — a second read of the same
        // row, and domain knowledge in the layer that is supposed to have none.
        if (actor !== undefined && existing.userId !== actor.userId && actor.role !== Role.Admin) {
            throw new ProblemError({
                status: 403,
                type: ProblemType.forbidden,
                title: 'Forbidden',
                detail: `Order ${orderId} does not belong to you.`,
            });
        }

        // Cancelled is where an order stops. Everything else is a step forward or a
        // correction, and deciding which transitions are legal beyond that is a domain
        // question this project has not been asked.
        if (existing.status === OrderStatus.Cancelled && status !== OrderStatus.Cancelled) {
            throw new ProblemError({
                status: 422,
                type: ProblemType.unprocessable,
                title: 'Unprocessable entity',
                detail: `Order ${orderId} is cancelled, and a cancelled order cannot become ${status}.`,
            });
        }

        // TypeORM answers [rows, affected] for UPDATE — see the gotchas in the README.
        const [changed] = await this.dataSource.query<[{ id: string }[], number]>(
            'UPDATE orders SET status = $2 WHERE id = $1 RETURNING id',
            [orderId, status],
        );

        if (changed[0] === undefined) {
            throw new ProblemError({
                status: 404,
                type: ProblemType.notFound,
                title: 'Resource not found',
                detail: `No order with id ${orderId}.`,
            });
        }

        this.events.publish(orderId, status);

        const updated = await this.orders.findById(orderId);

        if (updated === null) {
            throw new ProblemError({
                status: 404,
                type: ProblemType.notFound,
                title: 'Resource not found',
                detail: `No order with id ${orderId}.`,
            });
        }

        return updated;
    }
}
