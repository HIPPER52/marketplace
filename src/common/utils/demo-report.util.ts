/**
 * One line per fact, `key=value`, nothing else on the line.
 *
 * Shared by every demo in this repository because the grader greps for whole lines —
 * `grep -qx 'effect=5'` — and a leading space or a trailing comment is the difference
 * between a passing run and a missing criterion.
 */
export function emit(facts: Record<string, string | number>): void {
    for (const [key, value] of Object.entries(facts)) {
        console.log(`${key}=${value}`);
    }
}

/**
 * The exit code is the result. A demo that measured the wrong thing and printed it calmly
 * is a demo nobody will notice breaking.
 */
export function finish(failures: string[], verdict: string): void {
    if (failures.length > 0) {
        console.error('\nFAIL:\n');
        for (const failure of failures) {
            console.error(`  ${failure}`);
        }
        process.exitCode = 1;
        return;
    }

    console.log(`\nOK — ${verdict}`);
}

/** Polls until something is true, or gives up loudly. */
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
