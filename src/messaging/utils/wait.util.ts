/**
 * Poll until something is true, or give up loudly.
 *
 * Demos wait on the broker and on the database, and both answer "not yet" rather than
 * blocking. A fixed `sleep(2000)` would make every run either slower than it has to be or
 * flaky on a loaded laptop; a wait with a deadline fails with a sentence instead.
 */
export async function waitUntil(
    describe: string,
    predicate: () => boolean | Promise<boolean>,
    { timeoutMs = 15_000, intervalMs = 25 } = {},
): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    for (;;) {
        if (await predicate()) {
            return;
        }

        if (Date.now() >= deadline) {
            throw new Error(`timed out after ${timeoutMs} ms waiting for ${describe}`);
        }

        await sleep(intervalMs);
    }
}

export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
