import { generateKeyPairSync } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/schemas/env.schema';
import { TokenSigner } from '../services/token-signer.service';

/**
 * A signer over a pair generated here and thrown away with the process.
 *
 * For demos and tests that need a *real* token rather than a stub: the signature is
 * genuine, the algorithm is the pinned one, and nothing about the verification path is
 * mocked — only the key is temporary. A stub that returned a subject would have proved
 * that a stub returns a subject.
 *
 * The pair never touches disk, which is the same rule `npm run keygen` follows and the
 * reason the acceptance criteria can grep the tree for PEM headers and find none.
 */
export function ephemeralSigner(kid = 'ephemeral'): TokenSigner {
    const { privateKey, publicKey } = generateKeyPairSync('ec', {
        namedCurve: 'P-256',
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
    });

    const values: Record<string, string> = {
        JWT_KID: kid,
        JWT_PRIVATE_KEY: Buffer.from(privateKey).toString('base64'),
        JWT_PUBLIC_KEY: Buffer.from(publicKey).toString('base64'),
    };

    return new TokenSigner({
        get: (key: string) => values[key],
    } as unknown as ConfigService<Env, true>);
}
