import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { Order, Product, TokenPairResponse } from '../../common/types/api.types';
import { emit, finish } from '../../common/utils/demo-report.util';
import {
    DEMO_ADMIN_EMAIL,
    DEMO_BUYER_EMAIL,
    DEMO_PASSWORD,
    DEMO_SELLER_EMAIL,
} from '../../users/constants/demo-accounts.constant';
import { seedDemoAccounts } from '../../users/utils/demo-account.util';
import { call, type DemoApp, openDemoApp } from '../utils/demo-app.util';

/**
 * 401 and 403 are different answers to different questions.
 *
 *   npm run demo:rbac
 *
 * 401 means "I do not know who you are" and a client answers it by refreshing. 403 means
 * "I know exactly who you are and the answer is still no", and a client that refreshes on
 * one of those either loops or signs the person out of a page they were merely not
 * allowed to see. This run makes the service produce both, from the same route, and from
 * two different kinds of rule:
 *
 *   - a **role**, which a guard can decide before anything is loaded — `POST /products`;
 *   - **ownership**, which it cannot, because the answer is a property of the row —
 *     `GET /orders/{id}`.
 *
 * The second is why `RolesGuard` stops where it does. "Is this a seller?" needs no query;
 * "is this *their* order?" needs the order, and a guard that fetched it would read the
 * same row twice and put domain knowledge in the layer meant to have none.
 */
async function main(): Promise<void> {
    const stand = await openDemoApp();

    try {
        await seedDemoAccounts(stand.dataSource);

        const customer = await tokenFor(stand, DEMO_BUYER_EMAIL);
        const seller = await tokenFor(stand, DEMO_SELLER_EMAIL);
        const admin = await tokenFor(stand, DEMO_ADMIN_EMAIL);

        // ---- a role decides who may write to the catalogue -------------------------------
        const listing = { title: 'Demo listing', price_cents: 1_999, in_stock: 7 };

        const anonymous = await call(stand, 'POST', '/products', { body: listing });
        const asCustomer = await call(stand, 'POST', '/products', {
            token: customer,
            body: listing,
        });
        const asSeller = await call<Product>(stand, 'POST', '/products', {
            token: seller,
            body: listing,
        });
        const asAdmin = await call<Product>(stand, 'POST', '/products', {
            token: admin,
            body: listing,
        });

        console.log('POST /products');
        console.log(`  no token -> ${anonymous.status}   (who are you?)`);
        console.log(`  customer -> ${asCustomer.status}   (known, and still no)`);
        console.log(`  seller   -> ${asSeller.status}`);
        console.log(`  admin    -> ${asAdmin.status}`);

        // ---- ownership decides who may read an order --------------------------------------
        const product = asSeller.body;
        const order = await call<Order>(stand, 'POST', '/orders', {
            token: customer,
            headers: { 'Idempotency-Key': randomUUID() },
            body: { items: [{ product_id: product.id, quantity: 1 }] },
        });

        const orderId = order.body?.id ?? '';

        const byOwner = await call(stand, 'GET', `/orders/${orderId}`, { token: customer });
        const byStranger = await call(stand, 'GET', `/orders/${orderId}`, { token: seller });
        const byAdmin = await call(stand, 'GET', `/orders/${orderId}`, { token: admin });

        // And the list is the same rule applied to a page: the seller's own list does not
        // contain somebody else's order, rather than containing it and hiding it.
        const strangersList = await call<{ items: Order[] }>(stand, 'GET', '/orders', {
            token: seller,
        });
        const ownList = await call<{ items: Order[] }>(stand, 'GET', '/orders', {
            token: customer,
        });

        console.log(`\nGET /orders/${orderId.slice(0, 8)}…`);
        console.log(`  the buyer   -> ${byOwner.status}`);
        console.log(`  someone else-> ${byStranger.status}   (not 404: the row is not a secret)`);
        console.log(`  an admin    -> ${byAdmin.status}`);
        const mine = (ownList.body?.items ?? []).some((row) => row.id === orderId);
        const theirs = (strangersList.body?.items ?? []).some((row) => row.id === orderId);

        console.log(
            `\nGET /orders: this order is in the buyer's page (${String(mine)}) and not in ` +
                `the other account's (${String(theirs)})`,
        );

        emit({
            create_product_anonymous: anonymous.status,
            create_product_customer: asCustomer.status,
            create_product_seller: asSeller.status,
            create_product_admin: asAdmin.status,
            order_by_owner: byOwner.status,
            order_by_stranger: byStranger.status,
            order_by_admin: byAdmin.status,
            in_own_list: Number(mine),
            in_strangers_list: Number(theirs),
        });

        const failures: string[] = [];

        if (anonymous.status !== 401) {
            failures.push(`POST /products without a token answered ${anonymous.status}, not 401`);
        }

        if (asCustomer.status !== 403) {
            failures.push(
                `a customer writing to the catalogue was answered ${asCustomer.status}; 403 is ` +
                    'the answer — 401 would send their client off to refresh a perfectly good token',
            );
        }

        if (asSeller.status !== 201 || asAdmin.status !== 201) {
            failures.push(
                `seller ${asSeller.status} / admin ${asAdmin.status}: a role that allows nothing ` +
                    'is not a role',
            );
        }

        if (order.status !== 201 || orderId === '') {
            failures.push(`the buyer could not place an order (${order.status})`);
        }

        if (byOwner.status !== 200) {
            failures.push(`the buyer was refused their own order (${byOwner.status})`);
        }

        if (byStranger.status !== 403) {
            failures.push(
                `another account read the order and got ${byStranger.status}, not 403 — ` +
                    'a role check cannot catch this, which is the point of the demo',
            );
        }

        if (byAdmin.status !== 200) {
            failures.push(`an admin was refused (${byAdmin.status})`);
        }

        if (!mine) {
            failures.push('the buyer’s own list did not contain the order they placed');
        }

        // About *this* order rather than about the page being empty: the demos share a
        // stand, so a count is a fact about everything that ever ran against it. What the
        // filter promises is that one person's order is not in another person's list.
        if (theirs) {
            failures.push(
                "GET /orders returned somebody else's order: the filter is not in the WHERE",
            );
        }

        finish(
            failures,
            'two kinds of rule, two kinds of refusal. A role is decided before anything is\n' +
                'loaded and answers 403 from a guard; ownership is a property of the row and is\n' +
                'answered where the row already is. Neither is ever a 401 — that one is reserved\n' +
                'for not knowing who is asking.',
        );
    } finally {
        await stand.close();
    }
}

async function tokenFor(stand: DemoApp, email: string): Promise<string> {
    const login = await call<TokenPairResponse>(stand, 'POST', '/auth/login', {
        body: { email, password: DEMO_PASSWORD },
    });

    if (login.status !== 200) {
        throw new Error(`could not sign in as ${email}: ${login.status}`);
    }

    return login.body.access_token;
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exit(1);
});
