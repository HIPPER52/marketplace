/**
 * The fixture the three demos own.
 *
 * A product of their own rather than whatever `npm run seed` happened to insert first:
 * the demos have to run on a database that has only had its migrations applied, and they
 * must not quietly spend the stock of a product another demo is measuring. The id is a
 * literal because this is where it is defined — it is md5('marketplace:messaging-demo-
 * product') shaped into a UUID, the same way db/seed.sql addresses its rows, so every run
 * on every machine means the same row.
 */
export const DEMO_PRODUCT_ID = '521886c9-433e-4514-0f55-b1c4ac55ac52';

export const DEMO_PRODUCT_TITLE = 'Messaging demo relay';

/** Kopiykas. Small, round, and irrelevant to anything the demos assert. */
export const DEMO_UNIT_PRICE_CENTS = 1_000;

/** Restocked at the start of every run, so a long-lived stand cannot run the demos dry. */
export const DEMO_STOCK = 1_000;
