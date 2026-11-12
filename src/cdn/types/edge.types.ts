/** One object the edge is holding, and until when. */
export interface CachedObject {
    body: Buffer;
    contentType: string;
    cacheControl: string;
    /** Unix milliseconds. A shared cache may not serve past this without revalidating. */
    expiresAt: number;
}

/** What the edge did with a request, which is what the demo asserts on. */
export interface EdgeStats {
    hits: number;
    misses: number;
    /** Requests served from the origin because the object said not to cache it. */
    uncacheable: number;
}
