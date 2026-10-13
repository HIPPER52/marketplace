import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { configureApp } from '../../src/common/utils/configure-app.util';
import { aProduct } from '../testkit/builders';
import { type PgHandle, seatDemoBuyer, startPg, truncateAll } from '../testkit/pg-container';

/**
 * The whole application, assembled the way main.ts assembles it, over a Postgres that
 * started a second ago.
 *
 * Nothing is substituted: no provider is overridden, the OpenAPI validator runs on both
 * the request and the response, and the order that comes back was written by the same
 * transaction that moved the stock. The database reaches the app the way the assignment
 * asks for it — through the environment, from the container.
 */
let pg: PgHandle;
let app: INestApplication;

beforeAll(async () => {
    pg = await startPg('(e2e)');

    // Before compile(): ConfigModule validates process.env while the module graph is
    // being built, and it caches what it reads.
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = pg.env.DATABASE_URL;
    process.env.DB_PASSWORD_FILE = pg.env.DB_PASSWORD_FILE;

    // Pointed at an address nothing listens on, deliberately.
    //
    // @nestjs/config merges .env into what it validates, so deleting the variable from
    // process.env would not remove it: a developer whose stand has a broker would have
    // this suite publish real events into a live queue while CI published none — the same
    // machine-dependent difference test/testkit/jest-setup.ts exists to remove.
    //
    // Nothing is substituted to achieve it. The broker reaches the application through the
    // environment, the way the database does, and the address simply refuses connections.
    // That also makes the suite prove the decision in MessagingModule rather than assume
    // it: every order below is placed, and answered, while order.placed cannot be
    // published at all.
    process.env.BROKER_URL = 'amqp://unreachable:unreachable@127.0.0.1:1';

    const { AppModule } = await import('../../src/app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    app = moduleRef.createNestApplication({ bodyParser: false });
    await configureApp(app);
});

afterAll(async () => {
    // Both of these, or Jest hangs on an open pool: the app owns one, the testkit another.
    await app.close();
    await pg.stop();
});

beforeEach(async () => {
    await truncateAll(pg.dataSource);
    await seatDemoBuyer(pg.dataSource);
});

describe('orders', () => {
    test('POST /orders places an order and GET /orders/{id} reads it back', async () => {
        const product = await aProduct()
            .withTitle('Mechanical keyboard')
            .withPrice(260_000)
            .withStock(10)
            .insertVia(pg.dataSource.manager);

        const created = await request(app.getHttpServer())
            .post('/orders')
            .set('Idempotency-Key', 'e2e-happy-path-1')
            .send({ items: [{ product_id: product.id, quantity: 2 }] })
            .expect(201);

        expect(created.body).toMatchObject({
            status: 'pending',
            total_cents: 520_000,
            currency: 'UAH',
            items: [
                {
                    product_id: product.id,
                    quantity: 2,
                    unit_price_cents: 260_000,
                    subtotal_cents: 520_000,
                },
            ],
        });

        const fetched = await request(app.getHttpServer())
            .get(`/orders/${created.body.id}`)
            .expect(200);

        expect(fetched.body).toEqual(created.body);

        // The same transaction that wrote the order took the units off the shelf.
        const [row] = await pg.dataSource.query<{ in_stock: number }[]>(
            'SELECT in_stock FROM products WHERE id = $1',
            [product.id],
        );
        expect(row?.in_stock).toBe(8);
    });

    test('the same Idempotency-Key replays the first order instead of placing a second', async () => {
        const product = await aProduct().withStock(10).insertVia(pg.dataSource.manager);
        const body = { items: [{ product_id: product.id, quantity: 1 }] };

        const first = await request(app.getHttpServer())
            .post('/orders')
            .set('Idempotency-Key', 'e2e-replay-1')
            .send(body)
            .expect(201);

        const replay = await request(app.getHttpServer())
            .post('/orders')
            .set('Idempotency-Key', 'e2e-replay-1')
            .send(body)
            .expect(201);

        expect(replay.headers['idempotency-replay']).toBe('true');
        expect(replay.body.id).toBe(first.body.id);

        const [row] = await pg.dataSource.query<{ count: string }[]>('SELECT count(*) FROM orders');
        expect(row?.count).toBe('1');
    });

    test('GET /orders/{id} answers 404 as a problem document', async () => {
        const response = await request(app.getHttpServer())
            .get('/orders/00000000-0000-4000-8000-000000000000')
            .expect(404);

        expect(response.headers['content-type']).toMatch(/application\/problem\+json/);
        expect(response.body).toMatchObject({
            status: 404,
            title: 'Resource not found',
            instance: '/orders/00000000-0000-4000-8000-000000000000',
        });
    });

    test('POST /orders without Idempotency-Key is refused by the contract, not by an if', async () => {
        const response = await request(app.getHttpServer())
            .post('/orders')
            .send({ items: [{ product_id: '00000000-0000-4000-8000-000000000000', quantity: 1 }] })
            .expect(400);

        // The validator lower-cases header names the way Node does.
        expect(response.body.detail).toMatch(/idempotency-key/i);
    });
});
