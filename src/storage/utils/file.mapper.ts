import type { StoredFileResponse, UploadIntent } from '../../common/types/api.types';
import type { StoredFile } from '../entities/stored-file.entity';
import { type GrantedUpload, UploadMode } from '../types/upload.types';

/**
 * Entity to contract. Written by hand rather than spread, for the reason every mapper
 * here is: a spread makes the database schema a public API, and the first renamed column
 * breaks a client nobody in this repository can see.
 */
export function toApiFile(file: StoredFile): StoredFileResponse {
    return {
        id: file.id,
        object_key: file.objectKey,
        content_type: file.contentType,
        status: file.status,
        // bigint arrives as a string; money converts and sizes do too, because the
        // contract declares an integer. A null here would mean a row that is still
        // pending, which this mapper is only ever handed after a commit.
        size_bytes: Number(file.sizeBytes ?? 0),
    };
}

export function toApiIntent(granted: GrantedUpload): UploadIntent {
    const common = {
        file_id: granted.file.id,
        object_key: granted.file.objectKey,
        expires_in: granted.expiresIn,
    };

    if (granted.mode === UploadMode.Single) {
        return {
            ...common,
            mode: UploadMode.Single,
            url: granted.url,
            upload_id: null,
            part_size_bytes: null,
            parts: null,
        };
    }

    return {
        ...common,
        mode: UploadMode.Multipart,
        url: null,
        upload_id: granted.uploadId,
        part_size_bytes: granted.partSize,
        parts: granted.parts.map((part) => ({ part_number: part.partNumber, url: part.url })),
    };
}
