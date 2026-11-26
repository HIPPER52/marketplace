import type Redis from 'ioredis';

/**
 * Registers a Lua script on a connection under a name.
 *
 * `defineCommand` is worth the small ceremony over a bare `eval`: ioredis sends `EVALSHA`
 * and falls back to `EVAL` on `NOSCRIPT` by itself, so the script body crosses the wire
 * once per server rather than once per call, and a Redis that was restarted underneath
 * recovers without anybody noticing.
 */
export function defineScript(client: Redis, name: string, keys: number, lua: string): void {
    client.defineCommand(name, { numberOfKeys: keys, lua });
}

/** What a connection looks like once the scripts below are on it. */
export interface Scripted extends Redis {
    compareAndDelete(key: string, token: string): Promise<number>;
    slidingWindow(
        key: string,
        now: string,
        windowMs: string,
        limit: string,
        member: string,
    ): Promise<[number, number, number]>;
}
