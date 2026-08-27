import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type { components } from '../generated/api.js';
import { fingerprint, lookup, remember } from '../idempotency.js';
import { paginate, readLimit } from '../pagination.js';
import { ProblemError, ProblemType } from '../problem.js';
import type { Order } from '../store.js';
import { findOrder, findProduct, listOrders, saveOrder } from '../store.js';

type CreateOrderRequest = components['schemas']['CreateOrderRequest'];
type OrderItem = components['schemas']['OrderItem'];

export const ordersRouter = Router();

ordersRouter.get('/orders', (req, res) => {
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
    res.json(paginate(listOrders(), readLimit(req.query.limit), cursor));
});

ordersRouter.get('/orders/:orderId', (req, res) => {
    const order = findOrder(req.params.orderId);

    if (order === undefined) {
        throw new ProblemError({
            status: 404,
            type: ProblemType.notFound,
            title: 'Resource not found',
            detail: `No order with id ${req.params.orderId}.`,
        });
    }

    res.json(order);
});

function unprocessable(detail: string): ProblemError {
    return new ProblemError({
        status: 422,
        type: ProblemType.unprocessable,
        title: 'Unprocessable entity',
        detail,
    });
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

ordersRouter.post('/orders', (req, res) => {
    const key = req.headers['idempotency-key'] as string;
    const requestHash = fingerprint(req.body);
    const previous = lookup(key, requestHash);

    if (previous.outcome === 'conflict') {
        throw new ProblemError({
            status: 422,
            type: ProblemType.idempotencyConflict,
            title: 'Idempotency key reused with a different body',
            detail: `Idempotency-Key ${key} was already used for a different request body. Use a fresh key for a different order.`,
        });
    }

    if (previous.outcome === 'replay') {
        res.status(201).set('Idempotency-Replay', 'true').json(previous.order);
        return;
    }

    const order = buildOrder(req.body as CreateOrderRequest);
    saveOrder(order);
    remember(key, requestHash, order);

    res.status(201).json(order);
});
