const REDIS_PROTOCOLS = ['redis:', 'rediss:'] as const;

/**
 * What is wrong with a Redis URL, or null when nothing is.
 *
 * The same shape as `databaseUrlProblem` and `brokerUrlProblem`, and checked in both
 * places that read these variables — the demos' schema and the service's — so the two
 * cannot disagree about what a usable value looks like.
 */
export function redisUrlProblem(raw: string): string | null {
    let url: URL;

    try {
        url = new URL(raw);
    } catch {
        return 'must be a URL, e.g. redis://localhost:26379';
    }

    if (!REDIS_PROTOCOLS.includes(url.protocol as (typeof REDIS_PROTOCOLS)[number])) {
        return `must use one of ${REDIS_PROTOCOLS.join(' / ')}, got ${url.protocol}`;
    }

    return null;
}
