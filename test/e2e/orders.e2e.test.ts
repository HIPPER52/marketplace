import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { configureApp } from '../../src/common/utils/configure-app.util';
import {
    DEMO_BUYER_EMAIL,
    DEMO_PASSWORD,
    DEMO_SELLER_EMAIL,
} from '../../src/users/constants/demo-accounts.constant';
import { seatAccounts, seedSigningEnv } from '../testkit/auth';
import { aProduct } from '../testkit/builders';
import { type PgHandle, startPg, truncateAll } from '../testkit/pg-container';
import { type RedisHandle, startRedis } from '../testkit/redis-container';
import { seedStorageEnv } from '../testkit/storage';

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
let redis: RedisHandle;
let app: INestApplication;

/** The buyer's access token, re-minted after every TRUNCATE. */
let buyer: string;

beforeAll(async () => {
    pg = await startPg('(e2e)');
    redis = await startRedis('(e2e)');

    // Before compile(): ConfigModule validates process.env while the module graph is
    // being built, and it caches what it reads.
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = pg.env.DATABASE_URL;
    process.env.DB_PASSWORD_FILE = pg.env.DB_PASSWORD_FILE;

    // Redis is required, so the suite supplies one rather than pointing the application at
    // a developer's stand — a test that wrote into the machine's own cache would be a test
    // whose result depended on what else had run that day.
    process.env.REDIS_URL = redis.cacheUrl;
    process.env.REDIS_QUEUE_URL = redis.queueUrl;

    // Four required variables with no defaults — see env.schema.ts. The suite generates a
    // pair rather than carrying one, because a key in a test fixture is a key in git.
    seedSigningEnv();
    seedStorageEnv();

    // No broker variable here, and none needed. Since #22 the application does not talk to
    // a broker at all: placing an order writes an `outbox` row in the same transaction, and
    // carrying that row to RabbitMQ belongs to `npm run start:relay`, a different process.

    const { AppModule } = await import('../../src/app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    app = moduleRef.createNestApplication({ bodyParser: false });
    await configureApp(app);
});

afterAll(async () => {
    // Both of these, or Jest hangs on an open pool: the app owns one, the testkit another.
    await app.close();
    await pg.stop();
    await redis.stop();
});

beforeEach(async () => {
    await truncateAll(pg.dataSource);
    await seatAccounts(pg.dataSource);
    buyer = await signIn(DEMO_BUYER_EMAIL);
});

/** A real round trip through `POST /auth/login`, not a token minted beside the app. */
async function signIn(email: string): Promise<string> {
    const response = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email, password: DEMO_PASSWORD })
        .expect(200);

    return response.body.access_token as string;
}

describe('orders', () => {
    test('POST /orders places an order and GET /orders/{id} reads it back', async () => {
        const product = await aProduct()
            .withTitle('Mechanical keyboard')
            .withPrice(260_000)
            .withStock(10)
            .insertVia(pg.dataSource.manager);

        const created = await request(app.getHttpServer())
            .post('/orders')
            .set('Authorization', `Bearer ${buyer}`)
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
            .set('Authorization', `Bearer ${buyer}`)
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
            .set('Authorization', `Bearer ${buyer}`)
            .set('Idempotency-Key', 'e2e-replay-1')
            .send(body)
            .expect(201);

        const replay = await request(app.getHttpServer())
            .post('/orders')
            .set('Authorization', `Bearer ${buyer}`)
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
            .set('Authorization', `Bearer ${buyer}`)
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
            .set('Authorization', `Bearer ${buyer}`)
            .send({ items: [{ product_id: '00000000-0000-4000-8000-000000000000', quantity: 1 }] })
            .expect(400);

        // The validator lower-cases header names the way Node does.
        expect(response.body.detail).toMatch(/idempotency-key/i);
    });
});

describe('who may see an order', () => {
    test('without a token the list is 401, and the refusal names the scheme', async () => {
        const response = await request(app.getHttpServer()).get('/orders').expect(401);

        expect(response.headers['www-authenticate']).toMatch(/^Bearer/);
        expect(response.headers['content-type']).toMatch(/application\/problem\+json/);
        expect(response.body).toMatchObject({ status: 401, title: 'Not authenticated' });
    });

    test('another account reading this order gets 403, and its own list does not contain it', async () => {
        const product = await aProduct().withStock(10).insertVia(pg.dataSource.manager);

        const created = await request(app.getHttpServer())
            .post('/orders')
            .set('Authorization', `Bearer ${buyer}`)
            .set('Idempotency-Key', 'e2e-ownership-1')
            .send({ items: [{ product_id: product.id, quantity: 1 }] })
            .expect(201);

        const stranger = await signIn(DEMO_SELLER_EMAIL);

        // 403 and not 404: the id is in the buyer's own URL bar, so there is nothing to
        // hide — and a 404 would send a client looking for a resource that is right there.
        const forbidden = await request(app.getHttpServer())
            .get(`/orders/${created.body.id}`)
            .set('Authorization', `Bearer ${stranger}`)
            .expect(403);

        expect(forbidden.body).toMatchObject({ status: 403, title: 'Forbidden' });

        // The filter is in the WHERE rather than in a pass over the page: the stranger's
        // page is empty, not short.
        const theirs = await request(app.getHttpServer())
            .get('/orders')
            .set('Authorization', `Bearer ${stranger}`)
            .expect(200);

        expect(theirs.body.items).toHaveLength(0);

        const mine = await request(app.getHttpServer())
            .get('/orders')
            .set('Authorization', `Bearer ${buyer}`)
            .expect(200);

        expect(mine.body.items).toHaveLength(1);
    });

    test('the catalogue stays open: GET /products needs no token', async () => {
        await aProduct().insertVia(pg.dataSource.manager);

        await request(app.getHttpServer()).get('/products').expect(200);
    });

    test('a customer may not write to the catalogue, and the answer is 403 rather than 401', async () => {
        const response = await request(app.getHttpServer())
            .post('/products')
            .set('Authorization', `Bearer ${buyer}`)
            .send({ title: 'Not yours to add', price_cents: 100, in_stock: 1 })
            .expect(403);

        expect(response.body).toMatchObject({ status: 403, title: 'Forbidden' });

        const seller = await signIn(DEMO_SELLER_EMAIL);

        await request(app.getHttpServer())
            .post('/products')
            .set('Authorization', `Bearer ${seller}`)
            .send({ title: 'A seller may', price_cents: 100, in_stock: 1 })
            .expect(201);
    });
});
