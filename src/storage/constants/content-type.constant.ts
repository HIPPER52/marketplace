/**
 * What may be uploaded, and what the key's extension will be.
 *
 * **The extension comes from this table, never from the client's filename.** A filename
 * is a string the client wrote: `../../etc/passwd`, `x.png.svg`, 4 KB of Unicode. The
 * server names the object, so none of that reaches a key — `demo:upload` sends a
 * traversal on purpose and prints `key-from-server=1` when it did not.
 *
 * The `Content-Type` the client declares is also its own word. It is checked against this
 * allowlist because a type outside it has no business here at all, but a lie *inside* it
 * — a script with `image/png` on the envelope — is caught by reading the file's first
 * bytes, and that is #27's subject rather than this one's. Named here so the limit is not
 * mistaken for a guarantee.
 */
export const ALLOWED_CONTENT_TYPES = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'application/pdf': 'pdf',
    'text/css': 'css',
} as const;

export type AllowedContentType = keyof typeof ALLOWED_CONTENT_TYPES;

export const ALLOWED_CONTENT_TYPE_LIST = Object.keys(ALLOWED_CONTENT_TYPES) as AllowedContentType[];

export function isAllowedContentType(value: string): value is AllowedContentType {
    return value in ALLOWED_CONTENT_TYPES;
}

export function extensionFor(contentType: AllowedContentType): string {
    return ALLOWED_CONTENT_TYPES[contentType];
}
