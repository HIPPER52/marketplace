import { Controller, Get, Param, Query } from '@nestjs/common';
import { ProblemError, ProblemType } from '../../common/errors/problem.error';
import { findProduct, listProducts } from '../../common/store/catalog.store';
import { paginate, readLimit } from '../../common/utils/pagination.util';

@Controller()
export class ProductsController {
    @Get('products')
    list(@Query('limit') limit?: string, @Query('cursor') cursor?: string) {
        return paginate(listProducts(), readLimit(limit), cursor);
    }

    @Get('products/:productId')
    get(@Param('productId') productId: string) {
        const product = findProduct(productId);

        if (product === undefined) {
            throw new ProblemError({
                status: 404,
                type: ProblemType.notFound,
                title: 'Resource not found',
                detail: `No product with id ${productId}.`,
            });
        }

        return product;
    }
}
