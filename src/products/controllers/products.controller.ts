import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { CATALOGUE_WRITERS } from '../../auth/constants/role.constant';
import { Public } from '../../auth/decorators/public.decorator';
import { Roles } from '../../auth/decorators/roles.decorator';
import { ProductCardCache } from '../../cache/services/product-card-cache.service';
import { ProblemError, ProblemType } from '../../common/errors/problem.error';
import type { CreateProductRequest, Product } from '../../common/types/api.types';
import { pageOf, readCursor, readLimit } from '../../common/utils/pagination.util';
import { ProductsRepository } from '../repositories/products.repository';
import { toApiProduct, toApiProductCard } from '../utils/product.mapper';

@Controller()
export class ProductsController {
    constructor(
        private readonly products: ProductsRepository,
        private readonly cards: ProductCardCache,
    ) {}

    /**
     * The catalogue is public, and the two reads below say so explicitly.
     *
     * `@Public()` per route rather than on the controller, because the controller also
     * holds a write that is anything but. A shop whose shelves could only be seen after
     * signing in would be a different product; what needs proving is who may change them.
     */
    @Public()
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
    @Public()
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
    /**
     * Writing to the catalogue is for sellers and administrators.
     *
     * The decorator is the whole check, and it is the kind of check a guard *can* make: a
     * role is a property of the actor, so it is decidable before anything is loaded. The
     * moment the question became "may this seller edit *that* listing" it would stop
     * being decidable here — see OrdersController for where that line falls.
     *
     * A customer presenting a perfectly valid token gets 403, not 401. They are known;
     * the answer is still no, and their client must not try to refresh its way out of it.
     */
    @Roles(...CATALOGUE_WRITERS)
    @Post('products')
    @HttpCode(201)
    async create(@Body() body: CreateProductRequest): Promise<Product> {
        const product = await this.products.create({
            title: body.title,
            priceCents: body.price_cents,
            currency: body.currency,
            inStock: body.in_stock,
        });

        return toApiProduct(product);
    }
}
