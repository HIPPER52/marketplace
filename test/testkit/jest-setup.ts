/**
 * Runs before any test module is loaded, which is the only moment this can be fixed.
 *
 * `@pact-foundation/pact-core` builds a pino logger at import time from
 * `process.env.LOG_LEVEL`, and pino's levels are not Nest's. This project's own
 * LOG_LEVEL is `log` — valid for the service, meaningless to pino — so importing the
 * Verifier throws `default level:log must be included in custom levels` before a single
 * test runs. It only bites when the command comes through scripts/with-secrets.sh, which
 * exports everything in .env; without the wrapper the variable is simply absent and
 * nothing goes wrong, which is the worst kind of difference between two ways of running
 * the same command.
 *
 * The variable belongs to the service, so the service keeps it: removing it here lets
 * pact fall back to its own default, and @nestjs/config puts it back from .env when the
 * application module loads, well after pact's logger exists.
 */
const PINO_LEVELS = new Set(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']);

const level = process.env.LOG_LEVEL;

if (level !== undefined && !PINO_LEVELS.has(level)) {
    delete process.env.LOG_LEVEL;
}
