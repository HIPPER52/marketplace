import { generateKeyPairSync, randomBytes } from 'node:crypto';
import type { DataSource } from 'typeorm';
import { DEMO_PASSWORD } from '../../src/users/constants/demo-accounts.constant';
import { seedDemoAccounts } from '../../src/users/utils/demo-account.util';

/**
 * A signing pair for the suite, generated here and gone with the process.
 *
 * Must be called before `AppModule` is imported: `ConfigModule` validates the environment
 * while the module graph is built, and these four variables are required with no
 * defaults — which is the behaviour being relied on, not worked around.
 */
export function seedSigningEnv(): void {
    const { privateKey, publicKey } = generateKeyPairSync('ec', {
        namedCurve: 'P-256',
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
    });

    process.env.JWT_KID = 'test';
    process.env.JWT_PRIVATE_KEY = Buffer.from(privateKey).toString('base64');
    process.env.JWT_PUBLIC_KEY = Buffer.from(publicKey).toString('base64');
    process.env.REFRESH_TOKEN_PEPPER = randomBytes(32).toString('hex');
}

/** The demo accounts, with passwords, after a TRUNCATE has taken them away. */
export async function seatAccounts(dataSource: DataSource): Promise<void> {
    await seedDemoAccounts(dataSource, DEMO_PASSWORD);
}
