import 'reflect-metadata';
import { openStorageStand } from '../../storage/utils/storage-stand.util';
import { EDGE_PORT } from '../constants/edge.constant';
import { startEdge } from '../services/edge-server.service';

/**
 * The cache layer, as a long-running process.
 *
 *   npm run start:edge
 *
 * A process of its own rather than a route inside the API, and the reason is the thing
 * being taught: a CDN sits **in front of** the origin. Folding it into the service that
 * owns the contract would make "the bucket is closed and the cache is its only reader"
 * a sentence about two halves of one process, which proves nothing.
 */
async function main(): Promise<void> {
    const stand = openStorageStand();
    await stand.store.ensureBucket();

    const edge = await startEdge(stand.store, Number(process.env.EDGE_PORT ?? EDGE_PORT));

    console.log(`edge listening on ${edge.url}, origin ${stand.endpoint ?? 'AWS S3'}`);

    const stop = async (): Promise<void> => {
        await edge.close();
        stand.close();
        process.exit(0);
    };

    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
