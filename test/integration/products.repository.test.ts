import type { DataSource } from 'typeorm';
import { Currency } from '../../src/common/constants/currency.constant';
import { ProductsRepository } from '../../src/products/repositories/products.repository';
import { aProduct } from '../testkit/builders';
import { type PgHandle, startPg, truncateAll } from '../testkit/pg-container';
import { CHECK_VIOLATION, sqlStateOf } from '../testkit/pg-error';

let pg: PgHandle;
let dataSource: DataSource;
let repository: ProductsRepository;

beforeAll(async () => {
    pg = await startPg('(products)');
    dataSource = pg.dataSource;
    repository = new ProductsRepository(dataSource);
});

afterAll(async () => {
    await pg.stop();
});

beforeEach(async () => {
    await truncateAll(dataSource);
});

describe('ProductsRepository', () => {
    test('money comes back as a number, not the string the driver sends', async () => {
        const inserted = await aProduct().withPrice(260_000).insertVia(dataSource.manager);

        const found = await repository.findById(inserted.id);

        // price_cents is bigint. A mock would hand back whatever the author believed;
        // Postgres hands back '260000' and only the transformer makes it 260000.
        expect(found).not.toBeNull();
        expect(found?.priceCents).toBe(260_000);
        expect(typeof found?.priceCents).toBe('number');
        expect(found?.currency).toBe(Currency.UAH);
    });

    test('findById answers null for an id nobody issued', async () => {
        const found = await repository.findById('00000000-0000-4000-8000-000000000000');

        expect(found).toBeNull();
    });

    test('page slices the catalogue and reports the total behind it', async () => {
        for (let index = 0; index < 5; index += 1) {
            await aProduct().insertVia(dataSource.manager);
        }

        const first = await repository.page(2, 0);
        const second = await repository.page(2, 2);

        expect(first.total).toBe(5);
        expect(first.rows).toHaveLength(2);
        expect(second.rows).toHaveLength(2);

        // The pages must not overlap: an unstable sort under OFFSET shows the same row
        // twice and silently drops another, which no mock can reproduce.
        const ids = [...first.rows, ...second.rows].map((row) => row.id);
        expect(new Set(ids).size).toBe(4);
    });

    test('the CHECK constraint refuses a negative price', async () => {
        expect.assertions(2);

        try {
            await dataSource.manager.save(aProduct().withPrice(-1).build());
        } catch (error) {
            expect(sqlStateOf(error)).toBe(CHECK_VIOLATION);
            expect((error as Error).message).toMatch(/products_price_cents_nonnegative/);
        }
    });
});
