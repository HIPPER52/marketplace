import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ProblemError, ProblemType } from '../../common/errors/problem.error';
import type { CreateOrderRequest, Order } from '../../common/types/api.types';
import { pageOf, readCursor, readLimit } from '../../common/utils/pagination.util';
import { DEMO_BUYER_ID } from '../../users/constants/demo-buyer.constant';
import { OrdersRepository } from '../repositories/orders.repository';
import { CheckoutService } from '../services/checkout.service';
import { IdempotencyRegistry } from '../services/idempotency.service';
import type { CheckoutResult } from '../types/checkout.types';
import { toApiOrder } from '../utils/order.mapper';

@Controller()
export class OrdersController {
    constructor(
        private readonly idempotency: IdempotencyRegistry,
        private readonly orders: OrdersRepository,
        private readonly checkout: CheckoutService,
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
