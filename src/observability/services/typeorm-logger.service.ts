import type { LogLevel, LogMessage, Logger as TypeOrmLoggerInterface } from 'typeorm';
import { loggerFor } from '../utils/logger.util';

/**
 * TypeORM's own output, as JSON, and with the request's `trace_id` on it.
 *
 * The second half is what makes this worth the file. TypeORM logs a failing query from
 * inside the call that issued it, so the active span is still the request's — which means
 * a `duplicate key value violates unique constraint` line carries the same correlator as
 * the 500 the client saw, and the two are one search rather than two guesses about
 * timestamps.
 *
 * Only what the DataSource is configured to ask for arrives here. This project asks for
 * errors, warnings and migrations; it deliberately does not log every query, because the
 * statement a repository issues is a span in the trace already and a log line per query
 * is a bill rather than an answer.
 */
export class TypeOrmPinoLogger implements TypeOrmLoggerInterface {
    // Named `pino` and not `log`, because TypeORM's interface already has a method of that
    // name and the two would collide on this class.
    private readonly pino = loggerFor('typeorm');

    logQuery(query: string, parameters?: unknown[]): void {
        this.pino.debug({ query, parameters }, 'query');
    }

    logQueryError(error: string | Error, query: string, parameters?: unknown[]): void {
        this.pino.error(
            { err: error instanceof Error ? error.message : error, query, parameters },
            'query failed',
        );
    }

    logQuerySlow(time: number, query: string, parameters?: unknown[]): void {
        this.pino.warn({ duration_ms: time, query, parameters }, 'slow query');
    }

    logSchemaBuild(message: string): void {
        this.pino.debug(message);
    }

    logMigration(message: string): void {
        this.pino.info(message);
    }

    log(level: 'log' | 'info' | 'warn', message: string | LogMessage | LogMessage[]): void {
        const text = typeof message === 'string' ? message : JSON.stringify(message);

        if (level === 'warn') {
            this.pino.warn(text);
            return;
        }

        this.pino.info(text);
    }
}

/** What the DataSource asks this logger for — errors, warnings and migrations. */
export const TYPEORM_LOG_LEVELS: LogLevel[] = ['error', 'warn', 'migration'];
