import { Module } from '@nestjs/common';
import { DATA_SOURCE } from '../database/constants/database.constants';
import { ORDER_EVENT_PUBLISHER } from '../messaging/constants/messaging.constants';
import { MessagingModule } from '../messaging/messaging.module';
import { OrdersController } from './controllers/orders.controller';
import { OrdersGateway } from './gateways/orders.gateway';
import { OrdersRepository } from './repositories/orders.repository';
import { CheckoutService } from './services/checkout.service';
import { ClaimedIdentityService } from './services/claimed-identity.service';
import { IdempotencyRegistry } from './services/idempotency.service';
import { OrderEventsService } from './services/order-events.service';
import { OrderStatusService } from './services/order-status.service';

@Module({
    imports: [MessagingModule],
    controllers: [OrdersController],
    providers: [
        IdempotencyRegistry,
        OrdersRepository,
        ClaimedIdentityService,
        OrderEventsService,
        OrderStatusService,
        OrdersGateway,
        {
            // CheckoutService predates the DI graph — the HW-14 demos construct it with a
            // DataSource by hand, and it stays constructible that way. A factory keeps it
            // free of Nest decorators rather than making the demos import a module.
            provide: CheckoutService,
            inject: [DATA_SOURCE, ORDER_EVENT_PUBLISHER],
            useFactory: (
                dataSource: ConstructorParameters<typeof CheckoutService>[0],
                publisher: ConstructorParameters<typeof CheckoutService>[1],
            ) => new CheckoutService(dataSource, publisher),
        },
    ],
    exports: [OrdersRepository, OrderEventsService],
})
export class OrdersModule {}
