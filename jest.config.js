/**
 * One config for all three suites. The npm scripts pick a directory:
 *
 *   npm run test:integration   test/integration   repositories against a real Postgres
 *   npm run test:e2e           test/e2e           the whole Nest app through supertest
 *   npm run test:contract      test/contract      the consumer test that writes pacts/
 *   npm run verify:provider    test/contract      the provider verification
 *
 * `reporters` and `maxWorkers` are the two lines worth explaining.
 *
 * Jest 30 chooses a reporter by itself when none is named: it sniffs environment
 * variables, and in some of them it switches to a compact reporter that prints only
 * `Tests: N passed` — no `PASS <file>`, no test names, no ticks. Naming 'default'
 * explicitly makes the output the same wherever this runs, which matters because the
 * person running it is not always the person who wrote it.
 *
 * `maxWorkers: 1` because every worker starts its own Postgres container. Parallelism
 * here multiplies containers rather than dividing work, and on a small CI runner the
 * contention costs more than the concurrency buys. Green first, fast second.
 */
module.exports = {
    testEnvironment: 'node',
    // Before any test module is imported — see the file for the one thing it fixes.
    setupFiles: ['<rootDir>/test/testkit/jest-setup.ts'],
    rootDir: '.',
    testMatch: ['<rootDir>/test/**/*.test.ts'],
    transform: {
        // ts-jest, not a swc/esbuild transformer: those strip types without running the
        // TypeScript emitter, so `emitDecoratorMetadata` produces nothing and Nest's DI
        // — which reads constructor types from `design:paramtypes` — cannot resolve a
        // single provider.
        '^.+\\.ts$': ['ts-jest', { tsconfig: { noEmit: false } }],
    },
    reporters: ['default'],
    maxWorkers: 1,
    // A cold `docker pull postgres:17-alpine` is slower than Jest's default 5 s.
    testTimeout: 180_000,
};
