import {
    Body,
    Controller,
    Get,
    Headers,
    HttpCode,
    Param,
    Patch,
    Post,
    Query,
    Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { Role } from '../../auth/constants/role.constant';
import { CurrentUser } from '../../auth/decorators/principal.decorator';
import type { Principal } from '../../auth/types/auth.types';
import { ProblemError, ProblemType } from '../../common/errors/problem.error';
import type {
    CreateOrderRequest,
    Order,
    UpdateOrderStatusRequest,
} from '../../common/types/api.types';
import { pageOf, readCursor, readLimit } from '../../common/utils/pagination.util';
import { CheckoutOutcome, PlaceOrderOutcome } from '../constants/outcome.constant';
import { ORDER_STATUS_EVENT } from '../constants/realtime.constant';
import { OrdersRepository } from '../repositories/orders.repository';
import { OrderEventsService } from '../services/order-events.service';
import { OrderStatusService } from '../services/order-status.service';
import { PlaceOrderService } from '../services/place-order.service';
import type { CheckoutResult } from '../types/checkout.types';
import { type OrderEvent, toPayload } from '../types/order-event.types';
import { toApiOrder } from '../utils/order.mapper';

@Controller()
export class OrdersController {
    constructor(
        private readonly placeOrder: PlaceOrderService,
        private readonly orders: OrdersRepository,
        private readonly status: OrderStatusService,
        private readonly orderEvents: OrderEventsService,
    ) {}

    @Get('orders')
    async list(
        @CurrentUser() me: Principal,
        @Query('limit') limit?: string,
        @Query('cursor') cursor?: string,
    ) {
        const offset = readCursor(cursor);
        const { rows, total } = await this.orders.page(me.userId, readLimit(limit), offset);

        return pageOf(rows.map(toApiOrder), offset, total);
    }

    @Get('orders/:orderId')
    async get(@CurrentUser() me: Principal, @Param('orderId') orderId: string) {
        const order = await this.orders.findById(orderId);

        if (order === null) {
            throw new ProblemError({
                status: 404,
                type: ProblemType.notFound,
                title: 'Resource not found',
                detail: `No order with id ${orderId}.`,
            });
        }

        // 403 and not 404. Hiding the existence of a row behind "not found" is a real
        // technique and the right one where the id itself is a secret; an order id is
        // handed to its buyer and appears in their own URL bar, so there is nothing to
        // hide — and answering 404 to a caller who is simply not allowed sends their SDK
        // looking for a resource that is right there.
        denyUnlessOwned(order.userId, me, orderId);

        return toApiOrder(order);
    }

    @Post('orders')
    @HttpCode(201)
    async create(
        @CurrentUser() me: Principal,
        @Headers('idempotency-key') key: string,
        @Body() body: CreateOrderRequest,
        @Res({ passthrough: true }) res: Response,
    ): Promise<Order> {
        // One transaction moves the stock, the money, the order, its receipt job and the
        // outbox row that announces it. Every way it can refuse is data, not an exception
        // — see services/place-order.service.ts and types/checkout.types.ts.
        const placement = await this.placeOrder.place({ key, body, userId: me.userId });

        if (placement.outcome === PlaceOrderOutcome.Conflict) {
            throw new ProblemError({
                status: 422,
                type: ProblemType.idempotencyConflict,
                title: 'Idempotency key reused with a different body',
                detail: `Idempotency-Key ${key} was already used for a different request body. Use a fresh key for a different order.`,
            });
        }

        if (placement.outcome === PlaceOrderOutcome.InFlight) {
            // The key is reserved and the request that reserved it has not finished. A
            // replay cannot be served yet — there is nothing to replay — and placing a
            // second order would be exactly what the key exists to prevent.
            throw new ProblemError({
                status: 422,
                type: ProblemType.idempotencyInFlight,
                title: 'Idempotency key is still in use',
                detail: `Idempotency-Key ${key} belongs to a request that is still being processed. Retry in a moment to receive its result.`,
            });
        }

        if (placement.outcome === PlaceOrderOutcome.Refused) {
            throw unprocessable(explain(placement.result));
        }

        if (placement.outcome === PlaceOrderOutcome.Replayed) {
            res.setHeader('Idempotency-Replay', 'true');
        }

        const order = await this.orders.findById(placement.orderId);

        if (order === null) {
            throw new ProblemError({
                status: 500,
                type: ProblemType.internal,
                title: 'Internal server error',
                detail: `Order ${placement.orderId} was committed but could not be read back.`,
            });
        }

        return toApiOrder(order);
    }

    @Patch('orders/:orderId')
    async updateStatus(
        @CurrentUser() me: Principal,
        @Param('orderId') orderId: string,
        @Body() body: UpdateOrderStatusRequest,
    ): Promise<Order> {
        // The service writes the status and announces it. This route does neither
        // directly — see services/order-status.service.ts for why the emit lives there,
        // and for the ownership check that comes with the principal passed in.
        return toApiOrder(await this.status.changeStatus(orderId, body.status, me));
    }

    /**
     * The same stream of changes, over plain HTTP.
     *
     * Written against `@Res()` rather than Nest's `@Sse()` because this endpoint has two
     * requirements that decorator does not cover: the order has to be looked up *before*
     * any byte is written, so that an unknown id is an honest 404 rather than an empty
     * stream with a 200 on it; and `retry:` has to lead the body, which is how the
     * server sets the client's reconnect pace instead of leaving it at the browser
     * default of several seconds.
     */
    @Get('orders/:orderId/events')
    async events(
        @CurrentUser() me: Principal,
        @Param('orderId') orderId: string,
        @Res() res: Response,
        @Headers('last-event-id') lastEventId?: string,
    ): Promise<void> {
        const order = await this.orders.findById(orderId);

        if (order === null) {
            throw new ProblemError({
                status: 404,
                type: ProblemType.notFound,
                title: 'Resource not found',
                detail: `No order with id ${orderId}.`,
            });
        }

        // The same rule the gateway enforces on `join`, now resting on the same
        // verification. Until this assignment both transports took the caller's word for
        // who they were — `X-User-Id` here, `auth: { userId }` there — and a stream that
        // answered anyone would have made the WebSocket's check decorative, because the
        // identical events were one curl away. One rule, two transports, one proof.
        denyUnlessOwned(order.userId, me, orderId);

        res.writeHead(200, {
            'content-type': 'text/event-stream',
            // no-transform as well as no-cache: a compressing proxy that buffers to find
            // something to compress turns a live stream into a long silence.
            'cache-control': 'no-cache, no-transform',
            connection: 'keep-alive',
            'x-accel-buffering': 'no',
        });

        const write = (event: OrderEvent): void => {
            res.write(
                `id: ${event.id}\n` +
                    `event: ${ORDER_STATUS_EVENT}\n` +
                    `data: ${JSON.stringify(toPayload(event))}\n\n`,
            );
        };

        res.write('retry: 1000\n\n');

        // Everything this client missed while it was away, before the live feed starts.
        for (const missed of replayFor(this.orderEvents, orderId, lastEventId)) {
            write(missed);
        }

        const subscription = this.orderEvents.forOrder(orderId).subscribe(write);

        // A stream with nothing to say looks exactly like a dead connection to anything
        // between here and the client.
        const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 15_000);

        res.on('close', () => {
            clearInterval(keepAlive);
            subscription.unsubscribe();
            res.end();
        });
    }
}

/**
 * What to replay, from a header the client controls.
 *
 * No header at all means a client that has never been here: it gets the whole buffer.
 * A header that is present but unreadable means the opposite — this client has seen
 * *something* and we cannot tell what, so replaying everything would hand it duplicates
 * it has no way to recognise. It gets the live stream and nothing else.
 *
 * Over HTTP the second case cannot arrive: openapi.yaml declares `Last-Event-ID` as an
 * integer no smaller than zero, so the validator answers 400 first. This is what the
 * code does if that ever stops being true.
 */
function replayFor(
    events: OrderEventsService,
    orderId: string,
    rawLastEventId: string | undefined,
): OrderEvent[] {
    if (rawLastEventId === undefined) {
        return events.since(orderId, 0);
    }

    const parsed = Number(rawLastEventId);

    return Number.isInteger(parsed) && parsed >= 0 ? events.since(orderId, parsed) : [];
}

/**
 * The ownership check, in one place because it is one rule.
 *
 * An admin passes. That is the only thing a role decides here — everything else is "is
 * this row yours", which no guard can answer without loading the row, which is why this
 * lives beside the code that already has.
 */
function denyUnlessOwned(ownerId: string, actor: Principal, orderId: string): void {
    if (ownerId === actor.userId || actor.role === Role.Admin) {
        return;
    }

    throw new ProblemError({
        status: 403,
        type: ProblemType.forbidden,
        title: 'Forbidden',
        detail: `Order ${orderId} does not belong to you.`,
    });
}

function unprocessable(detail: string): ProblemError {
    return new ProblemError({
        status: 422,
        type: ProblemType.unprocessable,
        title: 'Unprocessable entity',
        detail,
    });
}

/** Every refusal checkout can return, in the words the customer gets. */
function explain(
    result: Exclude<CheckoutResult, { outcome: typeof CheckoutOutcome.Created }>,
): string {
    switch (result.outcome) {
        case CheckoutOutcome.UnknownProduct:
            // Also the answer when the product exists but is priced in another currency:
            // an order cannot mix currencies, so from this order's point of view there is
            // no such product to buy.
            return `No product with id ${result.productId} available in this currency.`;
        case CheckoutOutcome.OutOfStock:
            return `Product ${result.productId} has ${result.available} units in stock, ${result.requested} requested.`;
        case CheckoutOutcome.InsufficientFunds:
            return `The order costs ${result.requiredCents} cents and the account holds ${result.availableCents}.`;
    }
}
