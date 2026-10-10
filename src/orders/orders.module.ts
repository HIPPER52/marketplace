import { Module } from '@nestjs/common';
import { DATA_SOURCE } from '../database/constants/database.constants';
import { OrdersController } from './controllers/orders.controller';
import { OrdersRepository } from './repositories/orders.repository';
import { CheckoutService } from './services/checkout.service';
import { IdempotencyRegistry } from './services/idempotency.service';

@Module({
    controllers: [OrdersController],
    providers: [
        IdempotencyRegistry,
        OrdersRepository,
        {
            // CheckoutService predates the DI graph — the HW-14 demos construct it with a
            // DataSource by hand, and it stays constructible that way. A factory keeps it
            // free of Nest decorators rather than making the demos import a module.
            provide: CheckoutService,
            inject: [DATA_SOURCE],
            useFactory: (dataSource: ConstructorParameters<typeof CheckoutService>[0]) =>
                new CheckoutService(dataSource),
        },
    ],
    exports: [OrdersRepository],
})
export class OrdersModule {}
