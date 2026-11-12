#!/usr/bin/env node
/**
 * Proves that a status change reaches the order's own room and nowhere else.
 *
 *   node scripts/realtime-demo.mjs               # two clients, two rooms  -> B hears nothing
 *   node scripts/realtime-demo.mjs --same-room   # two clients, one room   -> B hears it
 *
 * Both runs execute the same code; the flag changes one value — which room the second
 * client joins — and the expectation that is checked against it. That is the point of
 * the control run: a script that always printed B_RECEIVED=0 would pass the first check
 * and fail this one, so a passing pair cannot be a constant.
 *
 * Exit 0 when reality matched the expectation, 1 when it did not.
 *
 * The application must be running — see the README, "Realtime".
 */
import { io } from 'socket.io-client';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000';

/**
 * Who the sockets are. Since #24 this is proved rather than claimed: the demo signs in
 * and hands the access token to the handshake, and the gateway runs it through the same
 * verification the HTTP guard does. Until then it was `auth: { userId }` — a number
 * anybody could type.
 */
const EMAIL = process.env.DEMO_EMAIL ?? 'buyer@marketplace.local';
const PASSWORD = process.env.DEMO_PASSWORD ?? 'demo-password';

let token = '';

const SAME_ROOM = process.argv.includes('--same-room');
const SETTLE_MS = 1500;

function fail(message) {
    console.error(`realtime-demo: ${message}`);
    process.exit(1);
}

async function api(path, init) {
    const response = await fetch(`${BASE_URL}${path}`, {
        ...init,
        headers: {
            ...init?.headers,
            ...(token === '' ? {} : { authorization: `Bearer ${token}` }),
        },
    });

    if (!response.ok) {
        const body = await response.text();
        fail(`${init?.method ?? 'GET'} ${path} answered ${response.status}: ${body}`);
    }

    return response.json();
}

/**
 * Signs in. The accounts come from `npm run demo:auth` (or any of the three auth demos),
 * which seed them with a password; a stand where they have never run has a buyer with no
 * password and this will say so.
 */
async function signIn() {
    const response = await fetch(`${BASE_URL}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });

    if (!response.ok) {
        fail(
            `could not sign in as ${EMAIL} (${response.status}). The demo accounts are ` +
                'created by `npm run demo:auth` — run it once against this stand.',
        );
    }

    const pair = await response.json();

    return pair.access_token;
}

/** A product with something on the shelf — checkout debits stock for real. */
async function pickProduct() {
    const page = await api('/products?limit=50');
    const stocked = page.items
        .filter((product) => product.in_stock > 0)
        .sort((left, right) => right.in_stock - left.in_stock)[0];

    if (stocked === undefined) {
        fail('no product has stock left. Run `npm run seed` and try again.');
    }

    return stocked;
}

async function placeOrder(productId, label) {
    const order = await api('/orders', {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'Idempotency-Key': `realtime-demo-${label}-${Date.now()}-${Math.random()}`,
        },
        body: JSON.stringify({ items: [{ product_id: productId, quantity: 1 }] }),
    });

    return order.id;
}

/** Connects, joins, and resolves only once the server has acknowledged the room. */
function watch(orderId) {
    return new Promise((resolve, reject) => {
        const socket = io(BASE_URL, {
            auth: { token },
            transports: ['websocket', 'polling'],
        });
        const received = [];

        socket.on('order.status', (event) => received.push(event));
        socket.on('connect_error', (error) => reject(new Error(`connect: ${error.message}`)));

        socket.on('connect', () => {
            // Join first, act second. A status changed before the ack arrives is a race
            // the demo would lose roughly at random, and the failure would look like
            // broken isolation rather than a mistimed script.
            socket.emit('join', { orderId }, (ack) => {
                if (ack?.ok !== true) {
                    reject(new Error(`join refused: ${ack?.error} — ${ack?.detail}`));
                    return;
                }

                resolve({ socket, received, room: ack.room });
            });
        });
    });
}

token = await signIn();

const product = await pickProduct();

const orderA = await placeOrder(product.id, 'a');
const orderB = await placeOrder(product.id, 'b');

const roomB = SAME_ROOM ? orderA : orderB;

const watcherA = await watch(orderA).catch((error) => fail(`client A: ${error.message}`));
const watcherB = await watch(roomB).catch((error) => fail(`client B: ${error.message}`));

console.log(`order A        ${orderA}`);
console.log(`order B        ${orderB}`);
console.log(`client A joined ${watcherA.room}`);
console.log(`client B joined ${watcherB.room}`);

await api(`/orders/${orderA}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'paid' }),
});

await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

const aReceived = watcherA.received.length > 0 ? 1 : 0;
const bReceived = watcherB.received.length > 0 ? 1 : 0;

watcherA.socket.close();
watcherB.socket.close();

console.log(`A_RECEIVED=${aReceived}`);
console.log(`B_RECEIVED=${bReceived}`);

const expectedB = SAME_ROOM ? 1 : 0;
const ok = aReceived === 1 && bReceived === expectedB;

if (!ok) {
    console.error(
        SAME_ROOM
            ? 'FAIL: both clients are in the same room, so both had to hear the change.'
            : 'FAIL: the clients are in different rooms, so B must not hear A order’s change.',
    );
}

process.exit(ok ? 0 : 1);
