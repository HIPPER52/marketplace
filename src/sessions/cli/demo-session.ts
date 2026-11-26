import 'reflect-metadata';
import type { Scripted } from '../../cache/utils/script.util';
import { emit, finish, sleep } from '../../common/utils/demo-report.util';
import { createRedis, quitQuietly } from '../../redis/utils/redis.util';
import { openRedisStand } from '../../redis/utils/redis-stand.util';
import { SessionStore } from '../services/session-store.service';

/**
 * Who came, between requests — and why the TTL has to move.
 *
 *   npm run demo:session
 *
 * Three requests a couple of seconds apart, all carrying the same identity. One session
 * key, and its expiry pushed back on every one of them: `ttl-renewed=1` is the difference
 * between a session and a thirty-minute countdown that logs a working person out mid-task.
 *
 * The gap between the requests is not padding. A rolling TTL is only observable once the
 * previous one has visibly shrunk; renewing an expiry that has not moved yet proves
 * nothing, and the usual way this requirement is passed without being met is a demo that
 * fires three requests in the same millisecond.
 *
 * The last check reads the session through a **connection opened after the fact**, which
 * is the closest a single process gets to asking "would this have survived a restart?".
 * A `Map` in the process answers that question with silence.
 */

const DEMO_TTL_SEC = 30;
const REQUESTS = 3;
const GAP_MS = 2_000;

async function main(): Promise<void> {
    const stand = await openRedisStand();
    let reopened: Scripted | null = null;

    try {
        const sessions = new SessionStore(stand.queue);
        const sessionId = `demo-session-${process.pid}`;

        // The run owns its state: a leftover key from an earlier run would make the first
        // request look like a renewal.
        await sessions.forget(sessionId);

        const seen = new Set<string>();
        let renewed = 0;
        let requests = 0;

        for (let i = 1; i <= REQUESTS; i += 1) {
            if (i > 1) {
                await sleep(GAP_MS);
            }

            const touch = await sessions.touch(sessionId, DEMO_TTL_SEC);

            if (touch === null) {
                throw new Error('the session store is unreachable');
            }

            requests += 1;
            seen.add(touch.sessionId);

            // -2 is "no such key", which is what the first request sees. A renewal is only
            // a renewal when there was something left to renew.
            if (touch.ttlBefore > 0 && touch.ttlAfter > touch.ttlBefore) {
                renewed = 1;
            }

            console.log(
                `request ${i}: requests=${touch.requests} ttl ${touch.ttlBefore}s -> ${touch.ttlAfter}s`,
            );
        }

        // ---- would it have survived the process? ------------------------------------------
        reopened = createRedis(stand.queueUrl) as Scripted;
        const fromScratch = await new SessionStore(reopened).read(sessionId);

        console.log(
            `\nread back through a fresh connection: ${
                fromScratch === null
                    ? 'nothing'
                    : `${fromScratch.requests} request(s), first seen ${fromScratch.firstSeenAt}`
            }`,
        );

        emit({
            requests,
            sessions: seen.size,
            'in-redis': fromScratch === null ? 0 : 1,
            'ttl-renewed': renewed,
        });

        const failures: string[] = [];

        if (seen.size !== 1) {
            failures.push(`${requests} requests with one identity produced ${seen.size} sessions`);
        }

        if (fromScratch === null) {
            failures.push('the session was not in Redis — process memory is not a session store');
        }

        if (renewed !== 1) {
            failures.push(
                'the TTL never grew: the session is on a fixed expiry, so an active user is ' +
                    'logged out mid-work',
            );
        }

        finish(
            failures,
            `${requests} requests, one session, and an expiry that moved with the activity.\n` +
                'It lives on the instance that may not evict: an LRU dropping a session is a\n' +
                'logout with no cause anybody can reproduce.',
        );
    } finally {
        await quitQuietly(reopened);
        await stand.close();
    }
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
