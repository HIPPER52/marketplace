import { MatchersV3, PactV3 } from '@pact-foundation/pact';
import {
    CONSUMER,
    KNOWN_PRODUCT_ID,
    MISSING_PRODUCT_ID,
    PACT_DIR,
    PROVIDER,
} from './pact.constants';

const { integer, string, uuid } = MatchersV3;

/**
 * The consumer half of the contract: a storefront that reads one product.
 *
 * There is no storefront in this repository, and that is the point — the contract is
 * written from the caller's side, against a mock server Pact stands up, and the artefact
 * it leaves in pacts/ is what the real provider is then held to. E2E cannot do this job:
 * it lives in one repository and can only ever check that this code agrees with itself.
 *
 * The matchers are deliberate. `integer(260000)` says "an integer here", not "260000" —
 * a contract pinned to values breaks every time somebody edits a seed, and a contract
 * that breaks for no reason is a contract people learn to ignore.
 */
const pact = new PactV3({
    consumer: CONSUMER,
    provider: PROVIDER,
    dir: PACT_DIR,
});

describe('marketplace-web talking to marketplace-api', () => {
    test('reads one product from the catalogue', async () => {
        pact.given(`product ${KNOWN_PRODUCT_ID} exists`)
            .uponReceiving('a request for a product that exists')
            .withRequest({ method: 'GET', path: `/products/${KNOWN_PRODUCT_ID}` })
            .willRespondWith({
                status: 200,
                body: {
                    id: uuid(KNOWN_PRODUCT_ID),
                    title: string('Mechanical keyboard'),
                    price_cents: integer(260_000),
                    currency: string('UAH'),
                    in_stock: integer(7),
                },
            });

        await pact.executeTest(async (mockServer) => {
            const response = await fetch(`${mockServer.url}/products/${KNOWN_PRODUCT_ID}`);

            expect(response.status).toBe(200);

            const body = (await response.json()) as { id: string; price_cents: number };
            expect(body.id).toBe(KNOWN_PRODUCT_ID);
            expect(typeof body.price_cents).toBe('number');
        });
    });

    test('is told, in RFC 7807, when a product does not exist', async () => {
        pact.given(`no product with id ${MISSING_PRODUCT_ID}`)
            .uponReceiving('a request for a product that does not exist')
            .withRequest({ method: 'GET', path: `/products/${MISSING_PRODUCT_ID}` })
            .willRespondWith({
                status: 404,
                // Declared, not inferred: Pact would otherwise assume application/json
                // from the shape of the body, and this contract is explicitly about the
                // RFC 7807 media type the API conventions promise.
                headers: { 'Content-Type': 'application/problem+json' },
                body: {
                    type: string('https://api.marketplace.local/problems/not-found'),
                    title: string('Resource not found'),
                    status: integer(404),
                    detail: string(`No product with id ${MISSING_PRODUCT_ID}.`),
                    instance: string(`/products/${MISSING_PRODUCT_ID}`),
                },
            });

        await pact.executeTest(async (mockServer) => {
            const response = await fetch(`${mockServer.url}/products/${MISSING_PRODUCT_ID}`);

            expect(response.status).toBe(404);
        });
    });
});
