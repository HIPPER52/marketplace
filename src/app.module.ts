import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validate } from './config/schemas/env.schema';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { OrdersModule } from './orders/orders.module';
import { ProductsModule } from './products/products.module';
import { QueueModule } from './queue/queue.module';
import { RateLimitModule } from './ratelimit/rate-limit.module';
import { RedisModule } from './redis/redis.module';
import { SessionMiddleware } from './sessions/middleware/session.middleware';
import { SessionsModule } from './sessions/sessions.module';

@Module({
    imports: [
        ConfigModule.forRoot({
            isGlobal: true,
            validate,
            cache: true,
        }),
        DatabaseModule,
        RedisModule,
        HealthModule,
        ProductsModule,
        OrdersModule,
        QueueModule,
        SessionsModule,
        RateLimitModule,
    ],
})
export class AppModule implements NestModule {
    /**
     * "Remember that this person was here" is true of every route and belongs to none of
     * them, so it is middleware rather than something a handler calls — the same argument
     * that keeps the realtime emit in a service.
     *
     * It runs ahead of the rate-limit guard, which is the right order: a request that is
     * about to be refused is still a request somebody made, and a session that only
     * advanced on success would forget exactly the clients worth remembering.
     */
    configure(consumer: MiddlewareConsumer): void {
        consumer.apply(SessionMiddleware).forRoutes('*');
    }
}
