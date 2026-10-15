import { Module } from '@nestjs/common';
import { DATA_SOURCE } from '../database/constants/database.constants';
import { MessagingModule } from '../messaging/messaging.module';
import { OutboxRepository } from '../messaging/repositories/outbox.repository';
import { OrdersController } from './controllers/orders.controller';
import { OrdersGateway } from './gateways/orders.gateway';
import { OrdersRepository } from './repositories/orders.repository';
import { CheckoutService } from './services/checkout.service';
import { ClaimedIdentityService } from './services/claimed-identity.service';
import { IdempotencyRegistry } from './services/idempotency.service';
import { OrderEventsService } from './services/order-events.service';
import { OrderStatusService } from './services/order-status.service';
import { PlaceOrderService } from './services/place-order.service';

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
        PlaceOrderService,
        {
            // CheckoutService predates the DI graph — the HW-14 demos construct it with a
            // DataSource by hand, and it stays constructible that way. A factory keeps it
            // free of Nest decorators rather than making the demos import a module.
            provide: CheckoutService,
            inject: [DATA_SOURCE, OutboxRepository, IdempotencyRegistry],
            useFactory: (
                dataSource: ConstructorParameters<typeof CheckoutService>[0],
                outbox: ConstructorParameters<typeof CheckoutService>[1],
                idempotency: IdempotencyRegistry,
            ) => new CheckoutService(dataSource, outbox, idempotency.completer),
        },
    ],
    exports: [OrdersRepository, OrderEventsService],
})
export class OrdersModule {}
