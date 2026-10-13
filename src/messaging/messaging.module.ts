import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/schemas/env.schema';
import { ORDER_EVENT_PUBLISHER } from './constants/messaging.constants';
import { OrderEventPublisher } from './services/order-event-publisher.service';

/**
 * The publisher, and the decision that it is allowed to be absent.
 *
 * `BROKER_URL` is optional for the HTTP service and required for the three demo scripts,
 * which is not a contradiction but a statement about what each one is for. The demos exist
 * to exercise the broker; without one they have nothing to say and fail loudly. The API
 * serves orders, and an order that was placed is still an order when the asynchronous
 * side-channel is unreachable — the same judgement #18 made about realtime: a channel
 * being unavailable is an honest state, and taking the synchronous API down with it would
 * be the worse outcome.
 *
 * It also keeps the E2E suite truthful. Nothing is substituted there — no provider is
 * overridden, no broker is mocked — so the application it builds is the application
 * without a broker, and it behaves exactly as a deployment in that situation would.
 *
 * The consumer is deliberately not here. Running it inside the API process would mean two
 * subscribers on one queue whenever a demo runs beside a local `npm start`, and the demo's
 * numbers would silently become a statement about which process won the race.
 */
@Module({
    providers: [
        {
            provide: ORDER_EVENT_PUBLISHER,
            inject: [ConfigService],
            useFactory: (config: ConfigService<Env, true>): OrderEventPublisher | null => {
                const url = config.get('BROKER_URL', { infer: true });

                if (url === undefined) {
                    new Logger(MessagingModule.name).warn(
                        'BROKER_URL is not set: orders will be placed but order.placed will ' +
                            'not be published. Set it to announce them.',
                    );

                    return null;
                }

                return new OrderEventPublisher(url);
            },
        },
    ],
    exports: [ORDER_EVENT_PUBLISHER],
})
export class MessagingModule {}
