import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validate } from './config/schemas/env.schema';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { OrdersModule } from './orders/orders.module';
import { ProductsModule } from './products/products.module';

@Module({
    imports: [
        ConfigModule.forRoot({
            isGlobal: true,
            validate,
            cache: true,
        }),
        DatabaseModule,
        HealthModule,
        ProductsModule,
        OrdersModule,
    ],
})
export class AppModule {}
