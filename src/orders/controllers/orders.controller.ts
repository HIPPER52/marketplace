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
import { ProblemError, ProblemType } from '../../common/errors/problem.error';
import type {
    CreateOrderRequest,
    Order,
    UpdateOrderStatusRequest,
} from '../../common/types/api.types';
import { pageOf, readCursor, readLimit } from '../../common/utils/pagination.util';
import { DEMO_BUYER_ID } from '../../users/constants/demo-buyer.constant';
import { ORDER_STATUS_EVENT, USER_ID_HEADER } from '../constants/realtime.constant';
import { OrdersRepository } from '../repositories/orders.repository';
import { CheckoutService } from '../services/checkout.service';
import { ClaimedIdentityService } from '../services/claimed-identity.service';
import { IdempotencyRegistry } from '../services/idempotency.service';
import { OrderEventsService } from '../services/order-events.service';
import { OrderStatusService } from '../services/order-status.service';
import type { CheckoutResult } from '../types/checkout.types';
import { type OrderEvent, toPayload } from '../types/order-event.types';
import { toApiOrder } from '../utils/order.mapper';

@Controller()
export class OrdersController {
    constructor(
        private readonly idempotency: IdempotencyRegistry,
        private readonly orders: OrdersRepository,
        private readonly checkout: CheckoutService,
        private readonly status: OrderStatusService,
        private readonly orderEvents: OrderEventsService,
        private readonly identity: ClaimedIdentityService,
    ) {}

    @Get('orders')
    async list(@Query('limit') limit?: string, @Query('cursor') cursor?: string) {
        const offset = readCursor(cursor);
        const { rows, total } = await this.orders.page(readLimit(limit), offset);

        return pageOf(rows.map(toApiOrder), offset, total);
    }

    @Get('orders/:orderId')
    async get(@Param('orderId') orderId: string) {
        const order = await this.orders.findById(orderId);

        if (order === null) {
            throw new ProblemError({
                status: 404,
                type: ProblemType.notFound,
                title: 'Resource not found',
                detail: `No order with id ${orderId}.`,
            });
        }

        return toApiOrder(order);
    }

    @Post('orders')
    @HttpCode(201)
    async create(
        @Headers('idempotency-key') key: string,
        @Body() body: CreateOrderRequest,
        @Res({ passthrough: true }) res: Response,
    ): Promise<Order> {
        const requestHash = this.idempotency.fingerprint(body);
        const previous = this.idempotency.lookup(key, requestHash);

        if (previous.outcome === 'conflict') {
            throw new ProblemError({
                status: 422,
                type: ProblemType.idempotencyConflict,
                title: 'Idempotency key reused with a different body',
                detail: `Idempotency-Key ${key} was already used for a different request body. Use a fresh key for a different order.`,
            });
        }

        if (previous.outcome === 'replay') {
            res.setHeader('Idempotency-Replay', 'true');
            return previous.order;
        }

        // One transaction moves the stock, the money, the order and its receipt job. The
        // ways it can refuse are data, not exceptions — see types/checkout.types.ts.
        const result = await this.checkout.checkout({
            userId: DEMO_BUYER_ID,
            lines: body.items.map((line) => ({
                productId: line.product_id,
                quantity: line.quantity,
            })),
            currency: body.currency,
        });

        if (result.outcome !== 'created') {
            throw unprocessable(explain(result));
        }

        const order = await this.orders.findById(result.orderId);

        if (order === null) {
            throw new ProblemError({
                status: 500,
                type: ProblemType.internal,
                title: 'Internal server error',
                detail: `Order ${result.orderId} was committed but could not be read back.`,
            });
        }

        const created = toApiOrder(order);
        this.idempotency.remember(key, requestHash, created);

        return created;
    }

    @Patch('orders/:orderId')
    async updateStatus(
        @Param('orderId') orderId: string,
        @Body() body: UpdateOrderStatusRequest,
    ): Promise<Order> {
        // The service writes the status and announces it. This route does neither
        // directly — see services/order-status.service.ts for why the emit lives there.
        return toApiOrder(await this.status.changeStatus(orderId, body.status));
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
        @Param('orderId') orderId: string,
        @Res() res: Response,
        @Headers(USER_ID_HEADER) userId?: string,
        @Headers('last-event-id') lastEventId?: string,
    ): Promise<void> {
        // The same rule the gateway enforces on `join`. An order's events are its
        // buyer's: a stream that answered anyone would make the WebSocket check
        // decorative, since the identical events are one curl away.
        //
        // openapi.yaml marks the header required with minLength 1, so the validator
        // answers 400 before this runs and the branch is unreachable over HTTP. It
        // answers with the same status for the same reason, so that the day the route
        // stops being validated — one line in `ignorePaths` — the stream does not quietly
        // become public.
        const claimant = this.identity.resolve(userId);

        if (claimant === null) {
            // Two different refusals wearing one status. Missing header: unreachable,
            // because openapi.yaml marks it required and the validator answers 400 first
            // — kept so that the day this route stops being validated the stream does not
            // quietly become public. Claims not accepted here: reachable, and the reason
            // the detail says so out loud.
            throw new ProblemError({
                status: this.identity.accepted ? 400 : 403,
                type: this.identity.accepted ? ProblemType.validation : ProblemType.forbidden,
                title: this.identity.accepted ? 'Request validation failed' : 'Forbidden',
                detail: this.identity.refusal(),
            });
        }

        const order = await this.orders.findById(orderId);

        if (order === null) {
            throw new ProblemError({
                status: 404,
                type: ProblemType.notFound,
                title: 'Resource not found',
                detail: `No order with id ${orderId}.`,
            });
        }

        if (order.userId !== claimant) {
            throw new ProblemError({
                status: 403,
                type: ProblemType.forbidden,
                title: 'Forbidden',
                detail: `Order ${orderId} does not belong to user ${claimant}.`,
            });
        }

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

function unprocessable(detail: string): ProblemError {
    return new ProblemError({
        status: 422,
        type: ProblemType.unprocessable,
        title: 'Unprocessable entity',
        detail,
    });
}

/** Every refusal checkout can return, in the words the customer gets. */
function explain(result: Exclude<CheckoutResult, { outcome: 'created' }>): string {
    switch (result.outcome) {
        case 'unknown-product':
            // Also the answer when the product exists but is priced in another currency:
            // an order cannot mix currencies, so from this order's point of view there is
            // no such product to buy.
            return `No product with id ${result.productId} available in this currency.`;
        case 'out-of-stock':
            return `Product ${result.productId} has ${result.available} units in stock, ${result.requested} requested.`;
        case 'insufficient-funds':
            return `The order costs ${result.requiredCents} cents and the account holds ${result.availableCents}.`;
    }
}
