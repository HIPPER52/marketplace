import { Module } from '@nestjs/common';
import { OrdersController } from './controllers/orders.controller';
import { IdempotencyRegistry } from './services/idempotency.service';

@Module({
    controllers: [OrdersController],
    providers: [IdempotencyRegistry],
})
export class OrdersModule {}
