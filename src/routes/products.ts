import { Router } from 'express';
import { paginate, readLimit } from '../pagination.js';
import { ProblemError, ProblemType } from '../problem.js';
import { findProduct, listProducts } from '../store.js';

export const productsRouter = Router();

productsRouter.get('/products', (req, res) => {
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
    res.json(paginate(listProducts(), readLimit(req.query.limit), cursor));
});

productsRouter.get('/products/:productId', (req, res) => {
    const product = findProduct(req.params.productId);

    if (product === undefined) {
        throw new ProblemError({
            status: 404,
            type: ProblemType.notFound,
            title: 'Resource not found',
            detail: `No product with id ${req.params.productId}.`,
        });
    }

    res.json(product);
});
