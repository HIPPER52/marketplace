import 'reflect-metadata';
import type { ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { rateLimitKey } from '../../cache/utils/cache-key.util';
import { defineScript, type Scripted } from '../../cache/utils/script.util';
import { ProblemError } from '../../common/errors/problem.error';
import { emit, finish } from '../../common/utils/demo-report.util';
import { USER_ID_HEADER } from '../../orders/constants/realtime.constant';
import { createRedis, quitQuietly } from '../../redis/utils/redis.util';
import { openRedisStand } from '../../redis/utils/redis-stand.util';
import { SLIDING_WINDOW } from '../constants/lua.constant';
import { RateLimitGuard } from '../guards/rate-limit.guard';
import { SlidingWindowLimiter } from '../services/sliding-window.service';

/**
 * One limit, two instances of the service.
 *
 *   npm run demo:ratelimit
 *
 * The demo raises **two** limiters, each with its own connection, and spends the allowance
 * across both. That is the whole test: a counter kept in process memory would let each of
 * them through `limit` times and the run would print `allowed = 2 x limit` while every
 * local test stayed green, because locally there is one process. `@nestjs/throttler`
 * counts in memory by default, which is the usual way this requirement is met halfway.
 *
 * The refusal itself comes from the production guard rather than from the demo, so
 * `status` and `retry-after` are what a client would actually receive — including the
 * header the contract declares as required on a 429.
 */

const LIMIT = 5;
const WINDOW_MS = 10_000;
const REQUESTS = 12;
const CLIENT = 'demo-ratelimit';

async function main(): Promise<void> {
    const stand = await openRedisStand();
    const second = createRedis(stand.queueUrl) as Scripted;

    try {
        // Two "pods": separate objects, separate sockets, one shared window.
        const { defineScript } = await import('../../cache/utils/script.util');
        const { SLIDING_WINDOW } = await import('../constants/lua.constant');
        defineScript(second, 'slidingWindow', 1, SLIDING_WINDOW);

        const pods = [
            new SlidingWindowLimiter(
                stand.cache === second ? second : stand.queue,
                LIMIT,
                WINDOW_MS,
            ),
            new SlidingWindowLimiter(second, LIMIT, WINDOW_MS),
        ];

        // The run owns its window.
        await stand.queue.del(rateLimitKey(`user:${CLIENT}`));

        let allowed = 0;
        let blocked = 0;

        for (let i = 0; i < REQUESTS; i += 1) {
            const pod = pods[i % pods.length];
            const decision = await (pod as SlidingWindowLimiter).take(`user:${CLIENT}`);

            if (decision.allowed) {
                allowed += 1;
            } else {
                blocked += 1;
            }
        }

        console.log(`${REQUESTS} requests split across ${pods.length} instances, limit ${LIMIT}`);
        console.log(`allowed ${allowed}, refused ${blocked}`);

        // ---- what a client actually receives -------------------------------------------
        const guard = new RateLimitGuard(pods[0] as SlidingWindowLimiter);
        let status = 0;
        let retryAfter = 0;

        try {
            await guard.canActivate(contextFor(CLIENT));
        } catch (error: unknown) {
            if (error instanceof ProblemError) {
                status = error.status;
                retryAfter = error.headers['Retry-After'] === undefined ? 0 : 1;
                console.log(
                    `\nthe guard answers ${status} with Retry-After: ${error.headers['Retry-After']} s`,
                );
                console.log(`  ${error.message}`);
            }
        }

        emit({
            instances: pods.length,
            limit: LIMIT,
            requests: REQUESTS,
            allowed,
            blocked,
            status,
            'retry-after': retryAfter,
        });

        const failures: string[] = [];

        if (allowed !== LIMIT) {
            failures.push(
                `${pods.length} instances let ${allowed} requests through against a limit of ` +
                    `${LIMIT}; a counter in process memory gives exactly this symptom`,
            );
        }

        if (blocked < 1) {
            failures.push('nothing was refused, so the limit was never reached');
        }

        if (status !== 429) {
            failures.push(`a refused request was answered with ${status}, not 429 (RFC 6585)`);
        }

        if (retryAfter !== 1) {
            failures.push('the 429 carried no Retry-After, so a client can only guess');
        }

        finish(
            failures,
            `two instances shared one allowance: ${allowed} through, ${blocked} refused with\n` +
                '429 and a Retry-After. The window is one Lua script, so it does not leak\n' +
                'between the count and the write — which is exactly when it would matter.',
        );
    } finally {
        await quitQuietly(second);
        await stand.close();
    }
}

/** The smallest thing the guard needs to decide. */
function contextFor(client: string): ExecutionContext {
    const request = {
        path: '/products',
        ip: '203.0.113.1',
        headers: { [USER_ID_HEADER.toLowerCase()]: client },
    } as unknown as Request;

    return {
        switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
