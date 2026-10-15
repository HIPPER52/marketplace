import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Verifier, type VerifierOptions } from '@pact-foundation/pact';
import { Currency } from '../../src/common/constants/currency.constant';
import { configureApp } from '../../src/common/utils/configure-app.util';
import { type PgHandle, seatDemoBuyer, startPg, truncateAll } from '../testkit/pg-container';
import {
    KNOWN_PRODUCT_ID,
    MISSING_PRODUCT_ID,
    PACT_FILE,
    PACT_VERSION,
    PROVIDER,
} from './pact.constants';

/**
 * The provider half: the real service, against the contract the consumer wrote.
 *
 * Nothing is mocked and nothing is overridden. A full Nest application boots over a
 * Postgres from testcontainers, Pact replays every interaction against it over HTTP, and
 * the provider states are satisfied by writing rows — the state handlers seat the
 * database, which is the only way "given product X exists" can mean anything.
 *
 * Where the contract comes from depends on PACT_BROKER_URL. Unset — the file in pacts/,
 * so this passes on a fresh clone with nothing running but Docker. Set — the broker, and
 * the result is published back to it, which is what makes can-i-deploy able to answer.
 */
let pg: PgHandle;
let app: INestApplication;
let port: number;

beforeAll(async () => {
    pg = await startPg('(provider)');

    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = pg.env.DATABASE_URL;
    process.env.DB_PASSWORD_FILE = pg.env.DB_PASSWORD_FILE;

    // No broker variable here, and none needed. Since #22 the application does not talk to
    // a broker at all: placing an order writes an `outbox` row in the same transaction, and
    // carrying that row to RabbitMQ belongs to `npm run start:relay`, a different process.
    // The suite that used to point this at a dead address to stop a developer's stand from
    // receiving real events now has nothing to point.

    const { AppModule } = await import('../../src/app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    app = moduleRef.createNestApplication({ bodyParser: false });
    await configureApp(app);

    // Port 0: the operating system picks a free one, so a verification run never
    // collides with a service already listening on 3000.
    await app.listen(0);
    port = (app.getHttpServer().address() as AddressInfo).port;
});

afterAll(async () => {
    await app.close();
    await pg.stop();
});

/**
 * One handler per `given(...)` in the contract.
 *
 * Both are idempotent — ON CONFLICT DO UPDATE and a DELETE that tolerates nothing to
 * delete — because Pact calls them once per interaction and a verification that only
 * works on a clean database is a verification that only works once.
 */
const stateHandlers = {
    [`product ${KNOWN_PRODUCT_ID} exists`]: async (): Promise<void> => {
        await truncateAll(pg.dataSource);
        // TRUNCATE takes the demo buyer with everything else, and that row came from a
        // migration rather than from a test. Nothing in today's contract places an order,
        // but the first interaction that does would fail here with a foreign key error
        // pointing at a user who no longer exists — a long way from the cause.
        await seatDemoBuyer(pg.dataSource);
        await pg.dataSource.query(
            `INSERT INTO products (id, title, description, price_cents, currency, in_stock)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (id) DO UPDATE
                SET title = EXCLUDED.title,
                    price_cents = EXCLUDED.price_cents,
                    currency = EXCLUDED.currency,
                    in_stock = EXCLUDED.in_stock`,
            [
                KNOWN_PRODUCT_ID,
                'Mechanical keyboard',
                'The product the contract is about.',
                260_000,
                Currency.UAH,
                7,
            ],
        );
    },

    [`no product with id ${MISSING_PRODUCT_ID}`]: async (): Promise<void> => {
        await pg.dataSource.query('DELETE FROM products WHERE id = $1', [MISSING_PRODUCT_ID]);
    },
};

function verifierOptions(): VerifierOptions {
    const brokerUrl = process.env.PACT_BROKER_URL;
    const brokerToken = process.env.PACT_BROKER_TOKEN;

    const base: VerifierOptions = {
        provider: PROVIDER,
        providerBaseUrl: `http://127.0.0.1:${port}`,
        providerVersion: PACT_VERSION,
        stateHandlers,
    };

    if (brokerUrl === undefined || brokerUrl === '') {
        return { ...base, pactUrls: [PACT_FILE] };
    }

    return {
        ...base,
        pactBrokerUrl: brokerUrl,
        ...(brokerToken === undefined || brokerToken === ''
            ? {}
            : { pactBrokerToken: brokerToken }),
        // Publishing is the half that matters to the gate: can-i-deploy answers `unknown`
        // until a verification result for this provider version exists in the broker.
        publishVerificationResult: true,
        consumerVersionSelectors: [{ latest: true }],
    };
}

test('the running service honours every interaction in the contract', async () => {
    // The verifier prints its own report — every interaction, every state, and which of
    // them matched. A rejection here is a failed test; the report is the detail.
    await new Verifier(verifierOptions()).verifyProvider();
});
