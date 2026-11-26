import { createHash } from 'node:crypto';
import { IMMUTABLE_CACHE_CONTROL } from '../constants/storage.constant';
import type { ObjectStore } from '../services/object-store.service';
import { assetKeyFor } from './object-key.util';

/** The first eight hex of a sha256 over the bytes. Short enough to read, long enough. */
export function contentHash(body: Buffer): string {
    return createHash('sha256').update(body).digest('hex').slice(0, 8);
}

/**
 * Publishes an asset under a name that contains its content.
 *
 * **This is the answer to "the file changed", and the reason nothing here ever calls an
 * invalidation API.** New bytes hash differently, so they land on a different key and
 * arrive under a different URL; the old entry in every cache between here and the user
 * stays valid and bothers nobody. That reaches the browser cache and the corporate proxy
 * — which an invalidation physically cannot, by CloudFront's own documentation — and it
 * makes a deploy one HTML file changing rather than hundreds of nodes being asked to
 * forget.
 *
 * `Cache-Control` goes **on the object, at upload time**. A cache layer cannot invent it:
 * without it a shared cache stores nothing, every request is a MISS, and the hit ratio is
 * zero for a reason nobody can see from the edge.
 */
export async function publishAsset(
    store: ObjectStore,
    input: { name: string; extension: string; contentType: string; body: Buffer },
): Promise<{ key: string; hash: string }> {
    const hash = contentHash(input.body);
    const key = assetKeyFor(input.name, hash, input.extension);

    await store.put(key, input.body, {
        contentType: input.contentType,
        cacheControl: IMMUTABLE_CACHE_CONTROL,
    });

    return { key, hash };
}
