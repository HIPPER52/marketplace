import 'reflect-metadata';
import type { DataSource } from 'typeorm';
import { AppDataSource } from '../../database/data-source';
import { DEMO_BUYER_ID } from '../../users/constants/demo-accounts.constant';
import { ASSET_PREFIX, UPLOAD_PREFIX } from '../constants/storage.constant';
import { StoredFile } from '../entities/stored-file.entity';
import { FilesRepository } from '../repositories/files.repository';
import { UploadsService } from '../services/uploads.service';
import { openStorageStand, type StorageStand } from './storage-stand.util';

export interface DemoStand extends StorageStand {
    dataSource: DataSource;
    files: FilesRepository;
    uploads: UploadsService;
    /** Removes everything a previous run of any of the three demos left behind. */
    reset(): Promise<void>;
    shutdown(): Promise<void>;
}

/**
 * The store, the database and the upload service, assembled by hand.
 *
 * The services are the ones the application injects — a demo that reimplemented the
 * signing or the two-step contract would be demonstrating itself. Nest is not booted
 * because two of the three demos have no HTTP in them at all; the one that does raises
 * the real application through `openDemoApp`.
 */
export async function openDemoStand(): Promise<DemoStand> {
    const storage = openStorageStand();
    const dataSource = await AppDataSource.initialize();
    const files = new FilesRepository(dataSource);
    const uploads = new UploadsService(files, storage.store, storage.presigner);

    await storage.store.ensureBucket();

    const reset = async (): Promise<void> => {
        await cleanDemoState(dataSource, storage);
    };

    return {
        ...storage,
        dataSource,
        files,
        uploads,
        reset,
        shutdown: async () => {
            storage.close();
            await dataSource.destroy();
        },
    };
}

/**
 * Brings the stand to clean — **a criterion rather than a courtesy.**
 *
 * `demo:multipart` is run twice in a row and must print `head-before-complete=404` both
 * times; a demo that left its object behind would answer 200 on the second run and the
 * run would be right to fail. Two kinds of rubbish have to go, and they are different
 * things:
 *
 * - **objects and rows**, found through the database rather than through a bucket
 *   listing. That is not a shortcut: the file list lives in Postgres precisely so nobody
 *   pays for `ListObjectsV2` to answer "what belongs to this user";
 * - **incomplete multipart uploads**, which no row may remember — the process that
 *   created one is the process that died. These are found with `ListMultipartUploads`,
 *   which is the one listing worth its cost, because an abandoned tail is billed while
 *   being invisible in every listing of objects.
 */
export async function cleanDemoState(dataSource: DataSource, storage: StorageStand): Promise<void> {
    const rows = await dataSource.getRepository(StoredFile).find({
        where: { ownerId: DEMO_BUYER_ID },
    });

    for (const row of rows) {
        if (row.uploadId !== null) {
            await storage.store.abortMultipart(row.objectKey, row.uploadId).catch(() => undefined);
        }

        await storage.store.delete(row.objectKey);
    }

    if (rows.length > 0) {
        await dataSource.getRepository(StoredFile).delete(rows.map((row) => row.id));
    }

    for (const prefix of [UPLOAD_PREFIX, ASSET_PREFIX]) {
        for (const tail of await storage.store.listIncomplete(prefix)) {
            await storage.store.abortMultipart(tail.key, tail.uploadId).catch(() => undefined);
        }
    }
}
