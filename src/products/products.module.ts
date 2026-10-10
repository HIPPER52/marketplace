import { Module } from '@nestjs/common';
import { ProductsController } from './controllers/products.controller';
import { ProductsRepository } from './repositories/products.repository';

@Module({
    controllers: [ProductsController],
    providers: [ProductsRepository],
    exports: [ProductsRepository],
})
export class ProductsModule {}
