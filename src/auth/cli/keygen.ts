import { generateKeyPairSync } from 'node:crypto';
import { JWT_ALGORITHMS } from '../constants/auth.constant';
import { fingerprint } from '../utils/key-fingerprint.util';

/**
 * Prints a signing pair as a block ready to paste into `.env` or into a shell.
 *
 *   npm run keygen -- dev-2026-10
 *
 * It writes nothing. A tool that creates key files invites a key file to be committed, and
 * the one thing this assignment is strict about is that no private key is ever in the
 * repository — the acceptance criteria grep tracked files for PEM headers *and* for their
 * base64, because a key that travels base64-encoded is a key somebody is tempted to paste
 * into a README.
 *
 * P-256 because the tokens are ES256; see JWT_ALGORITHMS for why that rather than RS256.
 */

const kid = process.argv[2] ?? `local-${new Date().toISOString().slice(0, 10)}`;

const { privateKey, publicKey } = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const b64 = (pem: string): string => Buffer.from(pem).toString('base64');

console.log(`# ${JWT_ALGORITHMS.join('/')} pair "${kid}" — fingerprint ${fingerprint(publicKey)}`);
console.log(`JWT_KID=${kid}`);
console.log(`JWT_PRIVATE_KEY=${b64(privateKey)}`);
console.log(`JWT_PUBLIC_KEY=${b64(publicKey)}`);
