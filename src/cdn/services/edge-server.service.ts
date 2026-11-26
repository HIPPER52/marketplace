import { createServer, type Server } from 'node:http';
import type { ObjectStore } from '../../storage/services/object-store.service';
import { EdgeCache } from './edge-cache.service';

export interface RunningEdge {
    url: string;
    cache: EdgeCache;
    close(): Promise<void>;
}

/**
 * The edge, as a process that listens.
 *
 * It goes to the store **with its own credentials** — that is the entire difference
 * between this and a public bucket, and the reason `demo:cdn` can prove `direct=403` and
 * `edge-miss=200` about the same object in the same breath.
 */
export async function startEdge(store: ObjectStore, port = 0): Promise<RunningEdge> {
    const cache = new EdgeCache(async (key) => {
        try {
            const object = await store.get(key);

            return {
                body: object.body,
                contentType: object.head.contentType,
                cacheControl: object.head.cacheControl,
            };
        } catch {
            return null;
        }
    });

    const server: Server = createServer((request, response) => {
        // Everything after the leading slash is the object key. No rewriting, no prefix
        // stripping: a cache that transformed keys would be a second place where a path
        // is decided, and the first one is already the server that composed it.
        const key = decodeURIComponent(new URL(request.url ?? '/', 'http://edge').pathname).slice(
            1,
        );

        cache
            .serve(key)
            .then((answer) => {
                response.writeHead(answer.status, answer.headers);
                response.end(answer.body);
            })
            .catch((error: unknown) => {
                response.writeHead(502, { 'content-type': 'text/plain' });
                response.end(error instanceof Error ? error.message : 'origin failed');
            });
    });

    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));

    const address = server.address();
    const listening = typeof address === 'object' && address !== null ? address.port : port;

    return {
        url: `http://127.0.0.1:${listening}`,
        cache,
        close: () =>
            new Promise<void>((resolve) => {
                server.close(() => resolve());
            }),
    };
}
