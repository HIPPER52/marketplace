import { Controller, Get, Param, Query } from '@nestjs/common';
import { ProductCardCache } from '../../cache/services/product-card-cache.service';
import { ProblemError, ProblemType } from '../../common/errors/problem.error';
import { pageOf, readCursor, readLimit } from '../../common/utils/pagination.util';
import { ProductsRepository } from '../repositories/products.repository';
import { toApiProduct, toApiProductCard } from '../utils/product.mapper';

@Controller()
export class ProductsController {
    constructor(
        private readonly products: ProductsRepository,
        private readonly cards: ProductCardCache,
    ) {}

    @Get('products')
    async list(@Query('limit') limit?: string, @Query('cursor') cursor?: string) {
        const offset = readCursor(cursor);
        const { rows, total } = await this.products.page(readLimit(limit), offset);

        return pageOf(rows.map(toApiProduct), offset, total);
    }

    /**
     * The one read in this service that is served from a cache.
     *
     * The card costs a join and an aggregate over every order line that ever named this
     * product, so its price grows with the history of the shop rather than with the
     * catalogue — and this is the route everybody opens. The handler does not know that:
     * it asks for a card and is given one, from Redis or from Postgres, and a Redis that
     * is down turns this into the query it always was.
     */
    @Get('products/:productId')
    async get(@Param('productId') productId: string) {
        const { card } = await this.cards.read(productId);

        if (card === null) {
            throw new ProblemError({
                status: 404,
                type: ProblemType.notFound,
                title: 'Resource not found',
                detail: `No product with id ${productId}.`,
            });
        }

        return toApiProductCard(card);
    }
}
