import { resolve } from 'node:path';

/**
 * Who is promising what to whom. The names are the identities the broker stores, so they
 * are read from one place by the consumer test, the provider verification, the CI job and
 * the README's curl commands alike.
 */
export const CONSUMER = 'marketplace-web';
export const PROVIDER = 'marketplace-api';

/**
 * One version for both sides, because nothing here is released independently yet. The
 * `prod` tag in the broker is applied to this exact provider version — a mismatch and
 * can-i-deploy honestly answers `unknown` forever.
 */
export const PACT_VERSION = process.env.PACT_VERSION ?? '1.0.0';

export const PACT_DIR = resolve(__dirname, '..', '..', 'pacts');
export const PACT_FILE = resolve(PACT_DIR, `${CONSUMER}-${PROVIDER}.json`);

/** A product the provider state seats, so the interaction is about a row that exists. */
export const KNOWN_PRODUCT_ID = '6f1c2a34-0d51-4b8e-9a7d-1f2e3c4b5a60';

/** A well-formed id that no state ever creates: the 404 half of the contract. */
export const MISSING_PRODUCT_ID = '00000000-0000-4000-8000-000000000000';
