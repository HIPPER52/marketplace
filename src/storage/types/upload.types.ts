import type { AllowedContentType } from '../constants/content-type.constant';
import type { StoredFile } from '../entities/stored-file.entity';
import type { UploadedPart } from './storage.types';

/** What a caller asks for. `ownerId` comes from a token and never from the body. */
export interface UploadRequest {
    ownerId: string;
    contentType: AllowedContentType;
    sizeBytes: number;
}

/** One part, and where to PUT it. */
export interface GrantedPart {
    partNumber: number;
    url: string;
}

/**
 * The grant, in the two shapes it comes in.
 *
 * A discriminated union rather than one object with everything nullable: `mode` decides
 * which half of the fields exist, and a type that admitted both at once would let a
 * handler read `parts` on a single PUT and find `undefined` at runtime.
 */
export type GrantedUpload =
    | {
          mode: typeof UploadMode.Single;
          file: StoredFile;
          expiresIn: number;
          url: string;
      }
    | {
          mode: typeof UploadMode.Multipart;
          file: StoredFile;
          expiresIn: number;
          uploadId: string;
          partSize: number;
          parts: GrantedPart[];
      };

export const UploadMode = {
    Single: 'single',
    Multipart: 'multipart',
} as const;

export type UploadMode = (typeof UploadMode)[keyof typeof UploadMode];

/** What a resumed upload did, which is the number `demo:multipart` is about. */
export interface ResumeResult {
    alreadyThere: UploadedPart[];
    uploaded: number;
}
