import { Module } from '@nestjs/common';
import { ProductCardCache } from '../cache/services/product-card-cache.service';
import { ProductsController } from './controllers/products.controller';
import { ProductsRepository } from './repositories/products.repository';

/**
 * The cache lives here rather than in a module of its own, because it is not a separate
 * concern: it is how one read of this catalogue is served. A `CacheModule` importing
 * products and products importing it back would have been a cycle describing nothing.
 */
@Module({
    controllers: [ProductsController],
    providers: [ProductsRepository, ProductCardCache],
    exports: [ProductsRepository, ProductCardCache],
})
export class ProductsModule {}
