/**
 * Something SQL can be sent to.
 *
 * Narrower than `DataSource` or `EntityManager` on purpose: the helpers that take this
 * run one statement and read one column, so demanding a whole DataSource would be asking
 * for a connection pool to count rows. Both TypeORM types satisfy it structurally, and so
 * does a stub — which is what makes a helper written against it testable without a
 * container.
 */
export interface Queryable {
    query(sql: string, parameters?: unknown[]): Promise<unknown>;
}
