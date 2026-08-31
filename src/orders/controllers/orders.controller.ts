import { randomUUID } from 'node:crypto';
import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ProblemError, ProblemType } from '../../common/errors/problem.error';
import { findOrder, findProduct, listOrders, saveOrder } from '../../common/store/catalog.store';
import type { CreateOrderRequest, Order, OrderItem } from '../../common/types/api.types';
import { paginate, readLimit } from '../../common/utils/pagination.util';
import { IdempotencyRegistry } from '../services/idempotency.service';

function unprocessable(detail: string): ProblemError {
    return new ProblemError({
        status: 422,
        type: ProblemType.unprocessable,
        title: 'Unprocessable entity',
        detail,
    });
}

@Controller()
export class OrdersController {
    constructor(private readonly idempotency: IdempotencyRegistry) {}

    @Get('orders')
    list(@Query('limit') limit?: string, @Query('cursor') cursor?: string) {
        return paginate(listOrders(), readLimit(limit), cursor);
    }

    @Get('orders/:orderId')
    get(@Param('orderId') orderId: string) {
        const order = findOrder(orderId);

        if (order === undefined) {
            throw new ProblemError({
                status: 404,
                type: ProblemType.notFound,
                title: 'Resource not found',
                detail: `No order with id ${orderId}.`,
            });
        }

        return order;
    }

    @Post('orders')
    @HttpCode(201)
    create(
        @Headers('idempotency-key') key: string,
        @Body() body: CreateOrderRequest,
        @Res({ passthrough: true }) res: Response,
    ): Order {
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

        const order = buildOrder(body);
        saveOrder(order);
        this.idempotency.remember(key, requestHash, order);

        return order;
    }
}

function buildOrder(body: CreateOrderRequest): Order {
    const currency = body.currency ?? 'UAH';
    const items: OrderItem[] = [];

    for (const line of body.items) {
        const product = findProduct(line.product_id);

        if (product === undefined) {
            throw unprocessable(`No product with id ${line.product_id}.`);
        }

        if (product.currency !== currency) {
            throw unprocessable(
                `Product ${product.id} is priced in ${product.currency}, but the order is in ${currency}.`,
            );
        }

        if (product.in_stock < line.quantity) {
            throw unprocessable(
                `Product ${product.id} has ${product.in_stock} units in stock, ${line.quantity} requested.`,
            );
        }

        items.push({
            product_id: product.id,
            quantity: line.quantity,
            unit_price_cents: product.price_cents,
            subtotal_cents: product.price_cents * line.quantity,
        });
    }

    return {
        id: randomUUID(),
        status: 'pending',
        items,
        total_cents: items.reduce((sum, item) => sum + item.subtotal_cents, 0),
        currency,
        created_at: new Date().toISOString(),
    };
}
