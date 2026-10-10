import type { DataSource } from 'typeorm';
import { OrderStatus } from '../../src/orders/constants/order-status.constant';
import { OrdersRepository } from '../../src/orders/repositories/orders.repository';
import { anOrder, aProduct, aUser } from '../testkit/builders';
import { type PgHandle, startPg, truncateAll } from '../testkit/pg-container';
import { FOREIGN_KEY_VIOLATION, sqlStateOf, UNIQUE_VIOLATION } from '../testkit/pg-error';

let pg: PgHandle;
let dataSource: DataSource;
let repository: OrdersRepository;

beforeAll(async () => {
    pg = await startPg('(orders)');
    dataSource = pg.dataSource;
    repository = new OrdersRepository(dataSource);
});

afterAll(async () => {
    await pg.stop();
});

beforeEach(async () => {
    await truncateAll(dataSource);
});

describe('OrdersRepository', () => {
    test('findById returns the order together with its line items', async () => {
        const buyer = await aUser().insertVia(dataSource.manager);
        const keyboard = await aProduct().withPrice(260_000).insertVia(dataSource.manager);
        const mouse = await aProduct().withPrice(89_000).insertVia(dataSource.manager);

        const placed = await anOrder()
            .for(buyer)
            .with(keyboard, 2)
            .with(mouse, 1)
            .insertVia(dataSource.manager);

        const found = await repository.findById(placed.id);

        expect(found).not.toBeNull();
        expect(found?.items).toHaveLength(2);
        expect(found?.totalCents).toBe(260_000 * 2 + 89_000);

        // product_id arrives through @RelationId rather than a column of its own, which
        // is the one thing a repository test can confirm and a unit test cannot.
        const byProduct = new Map(found?.items.map((item) => [item.productId, item.quantity]));
        expect(byProduct.get(keyboard.id)).toBe(2);
        expect(byProduct.get(mouse.id)).toBe(1);
    });

    test('findById answers null for an id nobody issued', async () => {
        const found = await repository.findById('00000000-0000-4000-8000-000000000000');

        expect(found).toBeNull();
    });

    test('page returns newest first, each order carrying its items', async () => {
        const buyer = await aUser().insertVia(dataSource.manager);
        const product = await aProduct().insertVia(dataSource.manager);

        const older = await anOrder().for(buyer).with(product, 1).insertVia(dataSource.manager);
        await dataSource.query(
            "UPDATE orders SET created_at = now() - interval '1 hour' WHERE id = $1",
            [older.id],
        );
        const newer = await anOrder()
            .for(buyer)
            .with(product, 3)
            .withStatus(OrderStatus.Paid)
            .insertVia(dataSource.manager);

        const { rows, total } = await repository.page(10, 0);

        expect(total).toBe(2);
        expect(rows.map((row) => row.id)).toEqual([newer.id, older.id]);
        expect(rows[0]?.status).toBe(OrderStatus.Paid);
        // relationLoadStrategy: 'query' — two statements, and the items are still here.
        expect(rows[0]?.items).toHaveLength(1);
        expect(rows[1]?.items).toHaveLength(1);
    });

    test('one line per product per order: a second line for the same product is rejected', async () => {
        expect.assertions(2);

        const buyer = await aUser().insertVia(dataSource.manager);
        const product = await aProduct().insertVia(dataSource.manager);

        try {
            await anOrder()
                .for(buyer)
                .with(product, 1)
                .with(product, 2)
                .insertVia(dataSource.manager);
        } catch (error) {
            expect(sqlStateOf(error)).toBe(UNIQUE_VIOLATION);
            expect((error as Error).message).toMatch(
                /duplicate key value violates unique constraint/,
            );
        }
    });

    test('a line item cannot name a product that does not exist', async () => {
        expect.assertions(2);

        const buyer = await aUser().insertVia(dataSource.manager);
        const product = await aProduct().insertVia(dataSource.manager);
        const placed = await anOrder().for(buyer).with(product, 1).insertVia(dataSource.manager);

        try {
            await dataSource.query(
                `INSERT INTO order_items (order_id, product_id, quantity, unit_price_cents, subtotal_cents)
                 VALUES ($1, $2, 1, 100, 100)`,
                [placed.id, '00000000-0000-4000-8000-000000000000'],
            );
        } catch (error) {
            expect(sqlStateOf(error)).toBe(FOREIGN_KEY_VIOLATION);
            expect((error as Error).message).toMatch(/violates foreign key constraint/);
        }
    });
});
