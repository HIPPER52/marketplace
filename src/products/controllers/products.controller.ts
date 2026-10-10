import { Controller, Get, Param, Query } from '@nestjs/common';
import { ProblemError, ProblemType } from '../../common/errors/problem.error';
import { pageOf, readCursor, readLimit } from '../../common/utils/pagination.util';
import { ProductsRepository } from '../repositories/products.repository';
import { toApiProduct } from '../utils/product.mapper';

@Controller()
export class ProductsController {
    constructor(private readonly products: ProductsRepository) {}

    @Get('products')
    async list(@Query('limit') limit?: string, @Query('cursor') cursor?: string) {
        const offset = readCursor(cursor);
        const { rows, total } = await this.products.page(readLimit(limit), offset);

        return pageOf(rows.map(toApiProduct), offset, total);
    }

    @Get('products/:productId')
    async get(@Param('productId') productId: string) {
        const product = await this.products.findById(productId);

        if (product === null) {
            throw new ProblemError({
                status: 404,
                type: ProblemType.notFound,
                title: 'Resource not found',
                detail: `No product with id ${productId}.`,
            });
        }

        return toApiProduct(product);
    }
}
