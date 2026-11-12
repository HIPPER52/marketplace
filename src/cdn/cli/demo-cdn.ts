import 'reflect-metadata';
import { emit, finish } from '../../common/utils/demo-report.util';
import {
    DEMO_ASSET_EXTENSION,
    DEMO_ASSET_NAME,
    DEMO_ASSET_V1,
    DEMO_ASSET_V2,
} from '../../storage/constants/demo.constant';
import { ASSET_PREFIX } from '../../storage/constants/storage.constant';
import { publishAsset } from '../../storage/utils/asset.util';
import { openDemoStand } from '../../storage/utils/demo-stand.util';
import { CACHE_HEADER, CacheOutcome } from '../constants/edge.constant';
import { startEdge } from '../services/edge-server.service';

/**
 * A closed bucket, a cache in front of it, and an update that needs no invalidation.
 *
 *   npm run demo:cdn
 *
 * Three claims, and each of them has a half it is easy to be mistaken for:
 *
 * - **the store is closed.** "I put a CDN in front of it" is also true of a public
 *   bucket with a cache bolted on; here an anonymous request straight at the bucket is
 *   `403`, and the only reader is the edge, which goes in with credentials. That is what
 *   origin access control *is* — the AWS form of the same sentence is a bucket policy,
 *   and README carries it.
 * - **the cache is a cache.** Second request, same URL, `X-Cache: HIT`, and the body
 *   never left the edge. It only holds what the object's own `Cache-Control` permits,
 *   which is why that header goes on at upload time.
 * - **the update cost zero invalidations.** New bytes hash differently, so they land on a
 *   different key and arrive under a different URL. The old entry stays valid and bothers
 *   nobody — which reaches the browser cache and the corporate proxy, where an
 *   invalidation by CloudFront's own documentation does not.
 */
async function main(): Promise<void> {
    const stand = await openDemoStand();
    const edge = await startEdge(stand.store, 0);

    try {
        await stand.reset();
        await removeDemoAssets(stand);

        // ---- deploy one -------------------------------------------------------------------
        const v1 = await publishAsset(stand.store, {
            name: DEMO_ASSET_NAME,
            extension: DEMO_ASSET_EXTENSION,
            contentType: 'text/css',
            body: Buffer.from(DEMO_ASSET_V1),
        });

        console.log(`published ${v1.key}`);

        // ---- the bucket is shut ------------------------------------------------------------
        const direct = await fetch(`${stand.endpoint}/${stand.bucket}/${v1.key}`);

        console.log(`anonymous GET straight at the bucket -> ${direct.status}`);

        // ---- and the edge is its only reader -----------------------------------------------
        const miss = await fetch(`${edge.url}/${v1.key}`);
        const missBody = await miss.text();
        const hit = await fetch(`${edge.url}/${v1.key}`);
        const hitBody = await hit.text();
        const cached = hit.headers.get(CACHE_HEADER) === CacheOutcome.Hit;

        console.log(
            `through the edge -> ${miss.status} ${miss.headers.get(CACHE_HEADER)}, ` +
                `then ${hit.status} ${hit.headers.get(CACHE_HEADER)}`,
        );

        // ---- deploy two: same asset, new bytes ----------------------------------------------
        const v2 = await publishAsset(stand.store, {
            name: DEMO_ASSET_NAME,
            extension: DEMO_ASSET_EXTENSION,
            contentType: 'text/css',
            body: Buffer.from(DEMO_ASSET_V2),
        });

        const fresh = await fetch(`${edge.url}/${v2.key}`);
        const freshBody = await fresh.text();

        // The old URL is still live and still old — which is the point rather than a flaw:
        // nothing had to be purged, and anything already holding it keeps working.
        const stale = await fetch(`${edge.url}/${v1.key}`);
        const staleBody = await stale.text();

        console.log(`\ndeploy: ${v1.key}\n     -> ${v2.key}`);
        console.log(`new URL   -> ${fresh.status} ${freshBody}`);
        console.log(`old URL   -> ${stale.status} ${staleBody}  (still cached, still valid)`);
        console.log('invalidations issued: 0');

        emit({
            direct: direct.status,
            'edge-miss': miss.status,
            'edge-hit': hit.status,
            'cache-hit': Number(cached),
            'new-name': Number(v2.key !== v1.key),
            'new-url': fresh.status,
            'content-changed': Number(freshBody === DEMO_ASSET_V2 && freshBody !== missBody),
            invalidations: 0,
        });

        const failures: string[] = [];

        if (direct.status !== 403) {
            failures.push(
                `an anonymous request straight at the bucket answered ${direct.status}, not 403: ` +
                    'the store is open, and the cache in front of it is decoration',
            );
        }

        if (miss.status !== 200 || hit.status !== 200) {
            failures.push(`the edge answered ${miss.status} then ${hit.status}`);
        }

        if (missBody !== DEMO_ASSET_V1 || hitBody !== DEMO_ASSET_V1) {
            failures.push('the edge served something other than what was published');
        }

        if (!cached) {
            failures.push(
                'the second request was not a HIT — almost always Cache-Control missing from ' +
                    'the object, because a shared cache stores only what the origin permits',
            );
        }

        if (v2.key === v1.key) {
            failures.push(
                'new content landed on the old key: the name is mutable, so an update would ' +
                    'need an invalidation and this demo has no subject',
            );
        }

        if (fresh.status !== 200 || freshBody !== DEMO_ASSET_V2) {
            failures.push(`the new URL answered ${fresh.status} with ${freshBody}`);
        }

        if (staleBody !== DEMO_ASSET_V1) {
            failures.push('the old URL stopped serving the old body, so something was purged');
        }

        finish(
            failures,
            'the bucket refuses the public and answers the cache; the second request never\n' +
                'left the edge; and new content arrived under a new URL while the old one kept\n' +
                'working. Zero invalidations — which is the only kind that reaches a browser.',
        );
    } finally {
        await edge.close();
        await removeDemoAssets(stand).catch(() => undefined);
        await stand.shutdown();
    }
}

/**
 * Both versions of the demo asset, by name.
 *
 * Computed rather than listed: the key is `assets/{name}.{hash}.{ext}` and the hash is of
 * content this file owns, so the two keys are derivable without paying for a listing.
 */
async function removeDemoAssets(stand: Awaited<ReturnType<typeof openDemoStand>>): Promise<void> {
    const { contentHash } = await import('../../storage/utils/asset.util');

    for (const body of [DEMO_ASSET_V1, DEMO_ASSET_V2]) {
        const hash = contentHash(Buffer.from(body));

        await stand.store.delete(
            `${ASSET_PREFIX}/${DEMO_ASSET_NAME}.${hash}.${DEMO_ASSET_EXTENSION}`,
        );
    }
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exit(1);
});
