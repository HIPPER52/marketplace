import { randomUUID } from 'node:crypto';
import { type AllowedContentType, extensionFor } from '../constants/content-type.constant';
import { ASSET_PREFIX, UPLOAD_PREFIX } from '../constants/storage.constant';

/**
 * The key an upload is written to — **composed here, from things the server knows**.
 *
 * `uploads/{ownerId}/{uuid}.{ext}`. The owner is the subject of a verified token, the
 * uuid is ours, the extension comes from the content-type allowlist. Nothing the client
 * sent appears in it, which is the point: hand a client any say over the key and you have
 * handed it the right to write anywhere in the bucket — `../`, a path that overwrites
 * somebody else's avatar, or a name that collides on purpose.
 */
export function uploadKeyFor(ownerId: string, contentType: AllowedContentType): string {
    return `${UPLOAD_PREFIX}/${ownerId}/${randomUUID()}.${extensionFor(contentType)}`;
}

/**
 * The key a public asset is published under: `assets/{name}.{hash}.{ext}`.
 *
 * The hash is of the content, so a new body cannot land on an old key — which is the
 * whole of RFC 8246 and the reason nothing here ever calls an invalidation API. See
 * README, "Updating without invalidating".
 */
export function assetKeyFor(name: string, contentHash: string, extension: string): string {
    return `${ASSET_PREFIX}/${name}.${contentHash}.${extension}`;
}
