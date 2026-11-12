import 'reflect-metadata';
import type { S3Client } from '@aws-sdk/client-s3';
import { readStorageEnv } from '../schemas/storage-env.schema';
import { ObjectStore } from '../services/object-store.service';
import { Presigner } from '../services/presigner.service';
import { createS3Client } from './s3-client.util';

export interface StorageStand {
    client: S3Client;
    bucket: string;
    store: ObjectStore;
    presigner: Presigner;
    /** Where the store answers, for the demos that make an anonymous request past us. */
    endpoint: string | undefined;
    close(): void;
}

/**
 * The store, assembled by hand for a process that does not boot Nest.
 *
 * The two services take their dependencies through constructor tokens, so building them
 * here is three lines and they are the **same classes** the application injects — a demo
 * that reimplemented the signing would be demonstrating itself.
 */
export function openStorageStand(): StorageStand {
    const env = readStorageEnv(process.env);
    const client = createS3Client(env);

    return {
        client,
        bucket: env.STORAGE_BUCKET,
        store: new ObjectStore(client, env.STORAGE_BUCKET),
        presigner: new Presigner(client, env.STORAGE_BUCKET),
        endpoint: env.STORAGE_ENDPOINT,
        close: () => client.destroy(),
    };
}
