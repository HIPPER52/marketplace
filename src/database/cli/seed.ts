import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { Currency } from '../../common/constants/currency.constant';
import { OrderStatus } from '../../orders/constants/order-status.constant';
import { Order } from '../../orders/entities/order.entity';
import { OrderItem } from '../../orders/entities/order-item.entity';
import { Product } from '../../products/entities/product.entity';
import { User } from '../../users/entities/user.entity';
import { AppDataSource } from '../data-source';

/**
 * A small, deterministic, idempotent seed.
 *
 *   npm run seed && npm run seed     # second run changes no row count
 *
 * Idempotency is not a loop that checks before inserting — it is one `ON CONFLICT DO
 * NOTHING` per table, resting on a key the data itself determines:
 *
 *   products, orders   id derived from a slug with md5, so the same slug is the same row
 *   users              e-mail, unique over lower(email)
 *   order_items        the (order, product) pair, unique by constraint
 *
 * That is also why nothing here uses `save()`. save() on an entity whose primary key is
 * absent — every order_item — inserts, and inserting twice is exactly what this file must
 * not do. The HW-12 bulk seed (db/seed.sql, 320 000 rows) is a different tool for a
 * different job and is not idempotent at all.
 */

/** A uuid that is a pure function of its name, so re-running addresses the same rows. */
function uuidFor(name: string): string {
    const hex = createHash('md5').update(name).digest('hex');
    return [
        hex.slice(0, 8),
        hex.slice(8, 12),
        hex.slice(12, 16),
        hex.slice(16, 20),
        hex.slice(20, 32),
    ].join('-');
}

interface ProductSeed {
    slug: string;
    title: string;
    description: string;
    priceCents: number;
    inStock: number;
}

const PRODUCTS: ProductSeed[] = [
    {
        slug: 'krosivky-dnipro',
        title: 'Шкіряні кросівки Дніпро M1042',
        description: 'Шкіряні кросівки для щоденного носіння у місті. Антиковзна підошва.',
        priceCents: 260000,
        inStock: 7,
    },
    {
        slug: 'cherevyky-karpaty',
        title: 'Зимові черевики Карпати M2210',
        description: 'Зимові черевики з мембраною. Утеплена підкладка тримає форму.',
        priceCents: 415000,
        inStock: 4,
    },
    {
        slug: 'ryukzak-tysa',
        title: 'Текстильні рюкзаки Тиса M3155',
        description: 'Місткий рюкзак для подорожей і відряджень. Відділення для ноутбука.',
        priceCents: 148000,
        inStock: 23,
    },
    {
        slug: 'sumka-lybid',
        title: 'Шкіряні сумки Либідь M4088',
        description: 'Шкіряна сумка для роботи та ділових зустрічей. Посилені шви.',
        priceCents: 320000,
        inStock: 11,
    },
    {
        slug: 'kurtka-vorskla',
        title: 'Утеплені куртки Ворскла M5301',
        description: 'Утеплена куртка для активного відпочинку. Водовідштовхувальне просочення.',
        priceCents: 530000,
        inStock: 9,
    },
    {
        slug: 'futbolka-stryi',
        title: 'Бавовняні футболки Стрий M6417',
        description: 'Бавовняна футболка для тренувань у залі та на вулиці.',
        priceCents: 54000,
        inStock: 64,
    },
    {
        slug: 'shapka-psel',
        title: 'Вовняні шапки Псел M7523',
        description: 'Вовняна шапка на холодний сезон. Тримає форму після прання.',
        priceCents: 39000,
        inStock: 38,
    },
    {
        slug: 'rukavychky-sula',
        title: 'Шкіряні рукавички Сула M8640',
        description: 'Шкіряні рукавички з утепленням. Сенсорні вставки на пальцях.',
        priceCents: 87000,
        inStock: 15,
    },
    {
        slug: 'navushnyky-ros',
        title: 'Бездротові навушники Рось M9712',
        description: 'Бездротові навушники для довгих прогулянок. Активне шумозаглушення.',
        priceCents: 690000,
        inStock: 6,
    },
    {
        slug: 'hodynnyk-zbruch',
        title: 'Класичні годинники Збруч M1888',
        description: 'Класичний годинник зі сталевим браслетом. Сапфірове скло.',
        priceCents: 1240000,
        inStock: 3,
    },
];

interface UserSeed {
    email: string;
    displayName: string;
}

const USERS: UserSeed[] = [
    { email: 'Oksana.Bondarenko@example.com', displayName: 'Оксана Бондаренко' },
    { email: 'Andrii.Shevchenko@example.com', displayName: 'Андрій Шевченко' },
    { email: 'Iryna.Tkachenko@mail.example.org', displayName: 'Ірина Ткаченко' },
    { email: 'Dmytro.Melnyk@shop.example.net', displayName: 'Дмитро Мельник' },
    { email: 'Nataliia.Kravchuk@example.com', displayName: 'Наталія Кравчук' },
    { email: 'Taras.Lysenko@mail.example.org', displayName: 'Тарас Лисенко' },
];

/** Which customer bought what. Index into USERS, then slugs with quantities. */
const ORDERS: { slug: string; buyer: number; status: OrderStatus; lines: [string, number][] }[] = [
    {
        slug: 'order-1',
        buyer: 0,
        status: OrderStatus.Shipped,
        lines: [
            ['krosivky-dnipro', 1],
            ['futbolka-stryi', 3],
        ],
    },
    {
        slug: 'order-2',
        buyer: 0,
        status: OrderStatus.Paid,
        lines: [['navushnyky-ros', 1]],
    },
    {
        slug: 'order-3',
        buyer: 1,
        status: OrderStatus.Pending,
        lines: [
            ['cherevyky-karpaty', 1],
            ['rukavychky-sula', 2],
            ['shapka-psel', 1],
        ],
    },
    {
        slug: 'order-4',
        buyer: 2,
        status: OrderStatus.Shipped,
        lines: [
            ['sumka-lybid', 1],
            ['hodynnyk-zbruch', 1],
        ],
    },
    {
        slug: 'order-5',
        buyer: 2,
        status: OrderStatus.Cancelled,
        lines: [['kurtka-vorskla', 1]],
    },
    {
        slug: 'order-6',
        buyer: 3,
        status: OrderStatus.Pending,
        lines: [
            ['ryukzak-tysa', 2],
            ['futbolka-stryi', 1],
        ],
    },
    {
        slug: 'order-7',
        buyer: 4,
        status: OrderStatus.Shipped,
        lines: [
            ['krosivky-dnipro', 2],
            ['shapka-psel', 2],
            ['rukavychky-sula', 1],
        ],
    },
    {
        slug: 'order-8',
        buyer: 5,
        status: OrderStatus.Paid,
        lines: [
            ['navushnyky-ros', 1],
            ['sumka-lybid', 1],
            ['ryukzak-tysa', 1],
        ],
    },
];

async function seed(): Promise<void> {
    const ds = await AppDataSource.initialize();

    try {
        const priceOf = new Map(PRODUCTS.map((p) => [p.slug, p.priceCents]));

        await ds
            .createQueryBuilder()
            .insert()
            .into(Product)
            .values(
                PRODUCTS.map((p) => ({
                    id: uuidFor(`product:${p.slug}`),
                    title: p.title,
                    description: p.description,
                    priceCents: p.priceCents,
                    currency: Currency.UAH,
                    inStock: p.inStock,
                })),
            )
            .orIgnore()
            .execute();

        await ds.createQueryBuilder().insert().into(User).values(USERS).orIgnore().execute();

        // Identity primary keys are assigned by the database, so the only way back to a
        // customer is the key the seed data owns: the e-mail.
        const users = await ds.getRepository(User).find();
        const userIdByEmail = new Map(users.map((u) => [u.email, u.id]));

        await ds
            .createQueryBuilder()
            .insert()
            .into(Order)
            .values(
                ORDERS.map((o) => ({
                    id: uuidFor(`order:${o.slug}`),
                    user: { id: userIdByEmail.get(USERS[o.buyer]?.email ?? '') } as User,
                    status: o.status,
                    currency: Currency.UAH,
                    totalCents: o.lines.reduce(
                        (sum, [slug, qty]) => sum + (priceOf.get(slug) ?? 0) * qty,
                        0,
                    ),
                })),
            )
            .orIgnore()
            .execute();

        await ds
            .createQueryBuilder()
            .insert()
            .into(OrderItem)
            .values(
                ORDERS.flatMap((o) =>
                    o.lines.map(([slug, quantity]) => {
                        const unitPriceCents = priceOf.get(slug) ?? 0;

                        return {
                            order: { id: uuidFor(`order:${o.slug}`) } as Order,
                            product: { id: uuidFor(`product:${slug}`) } as Product,
                            quantity,
                            unitPriceCents,
                            subtotalCents: unitPriceCents * quantity,
                        };
                    }),
                ),
            )
            .orIgnore()
            .execute();

        const counts = {
            users: await ds.getRepository(User).count(),
            products: await ds.getRepository(Product).count(),
            orders: await ds.getRepository(Order).count(),
            order_items: await ds.getRepository(OrderItem).count(),
        };

        console.log('Seeded. Row counts:');
        for (const [table, count] of Object.entries(counts)) {
            console.log(`  ${table.padEnd(12)} ${count}`);
        }
        console.log('\nRun it again — every number above stays where it is.');
    } finally {
        await ds.destroy();
    }
}

seed().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
