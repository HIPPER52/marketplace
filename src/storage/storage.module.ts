import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/schemas/env.schema';
import { STORAGE_BUCKET, STORAGE_CLIENT } from './constants/storage.tokens';
import { UploadsController } from './controllers/uploads.controller';
import { FilesRepository } from './repositories/files.repository';
import { ObjectStore } from './services/object-store.service';
import { Presigner } from './services/presigner.service';
import { UploadQueue } from './services/upload-queue.service';
import { UploadReaper } from './services/upload-reaper.service';
import { UploadsService } from './services/uploads.service';
import { createS3Client } from './utils/s3-client.util';

/**
 * The object store, and the two routes that put things in it.
 *
 * `@Global` for the same reason `AuthModule` is: the queue module's reaper needs the
 * store, and an `imports: [StorageModule]` there would add an edge to the graph Nest
 * walks when it collects `APP_GUARD` providers — which is the graph that decides the
 * order those guards run in.
 *
 * The client is a factory because it is built from the environment, and the bucket is a
 * string: neither is a class Nest could resolve by type, which is what the two tokens in
 * constants/storage.tokens.ts are for.
 */
@Global()
@Module({
    controllers: [UploadsController],
    providers: [
        {
            provide: STORAGE_CLIENT,
            inject: [ConfigService],
            useFactory: (config: ConfigService<Env, true>) =>
                createS3Client({
                    STORAGE_ENDPOINT: config.get('STORAGE_ENDPOINT', { infer: true }),
                    STORAGE_REGION: config.get('STORAGE_REGION', { infer: true }),
                    STORAGE_ACCESS_KEY: config.get('STORAGE_ACCESS_KEY', { infer: true }),
                    STORAGE_SECRET_KEY: config.get('STORAGE_SECRET_KEY', { infer: true }),
                    STORAGE_BUCKET: config.get('STORAGE_BUCKET', { infer: true }),
                }),
        },
        {
            provide: STORAGE_BUCKET,
            inject: [ConfigService],
            useFactory: (config: ConfigService<Env, true>) =>
                config.get('STORAGE_BUCKET', { infer: true }),
        },
        ObjectStore,
        Presigner,
        FilesRepository,
        UploadsService,
        UploadReaper,
        UploadQueue,
    ],
    exports: [ObjectStore, Presigner, FilesRepository, UploadsService, UploadReaper],
})
export class StorageModule {}
