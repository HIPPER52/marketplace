import { Inject, Injectable } from '@nestjs/common';
import { DataSource, LessThan, type Repository } from 'typeorm';
import { DATA_SOURCE } from '../../database/constants/database.constants';
import { FileStatus } from '../constants/file-status.constant';
import { StoredFile } from '../entities/stored-file.entity';

/** What `intent` reserves, before any byte exists. */
export interface NewFile {
    ownerId: string;
    objectKey: string;
    contentType: string;
    uploadId: string | null;
}

/** What `commit` learned from the store. */
export interface CompletedFile {
    sizeBytes: number;
}

@Injectable()
export class FilesRepository {
    private readonly files: Repository<StoredFile>;

    constructor(@Inject(DATA_SOURCE) dataSource: DataSource) {
        this.files = dataSource.getRepository(StoredFile);
    }

    /**
     * The reservation. Written before the client is told where to put the bytes, so that
     * there is never an object in the bucket this table has not heard of.
     */
    reserve(input: NewFile): Promise<StoredFile> {
        return this.files.save(
            this.files.create({
                owner: { id: input.ownerId },
                ownerId: input.ownerId,
                objectKey: input.objectKey,
                contentType: input.contentType,
                uploadId: input.uploadId,
                status: FileStatus.Pending,
            }),
        );
    }

    findById(id: string): Promise<StoredFile | null> {
        return this.files.findOne({ where: { id } });
    }

    findByKey(objectKey: string): Promise<StoredFile | null> {
        return this.files.findOne({ where: { objectKey } });
    }

    /** The size comes from `HeadObject`, which is the only source that cannot be argued with. */
    async complete(id: string, found: CompletedFile): Promise<StoredFile> {
        await this.files.update(id, {
            status: FileStatus.Completed,
            sizeBytes: String(found.sizeBytes),
            completedAt: new Date(),
        });

        const updated = await this.findById(id);

        if (updated === null) {
            throw new Error(`File ${id} was completed and could not be read back.`);
        }

        return updated;
    }

    /**
     * Reservations nobody finished. What the reaper claims.
     *
     * Read through the partial index: `status = 'pending'` is the predicate it was built
     * for, and in a mature table almost every row is completed.
     */
    abandoned(olderThan: Date, limit: number): Promise<StoredFile[]> {
        return this.files.find({
            where: { status: FileStatus.Pending, createdAt: LessThan(olderThan) },
            order: { createdAt: 'ASC' },
            take: limit,
        });
    }

    async remove(id: string): Promise<void> {
        await this.files.delete(id);
    }
}
