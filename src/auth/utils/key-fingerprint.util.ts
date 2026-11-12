import { createHash, createPublicKey } from 'node:crypto';

/**
 * A short, non-secret name for a key pair.
 *
 * Computed from the **public** half, so printing it reveals nothing — and that is the
 * whole point. There is no safe way to log a signing key and no way at all to confirm
 * "this pod picked up the new key" without logging *something*; a fingerprint is the
 * something. It is also how `dev` and `prod` are shown to be different environments
 * without either value appearing anywhere.
 */
export function fingerprint(publicKeyPem: string): string {
    const der = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });

    return createHash('sha256').update(der).digest('hex').slice(0, 8);
}
