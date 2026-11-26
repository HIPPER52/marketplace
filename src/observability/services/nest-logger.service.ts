import type { LoggerService } from '@nestjs/common';
import { rootLogger } from '../utils/logger.util';

/**
 * Nest's own logs, as JSON.
 *
 * Without this the first thing in the log of every run is Nest's startup banner in plain
 * text with colour escapes in it, and `demo:logs` counts `non-json-lines` over the whole
 * of stdout. It is not a cosmetic number: a log where some lines are objects and some are
 * sentences is a log that has to be grepped, which is the thing structured logging exists
 * to stop.
 *
 * Nest passes the component name as the **last** argument of a variadic call — the
 * `[Nest] 1 - … [NestFactory]` part of the pretty line — so it becomes `layer`, the same
 * field every other logger in this service sets.
 */
export class NestPinoLogger implements LoggerService {
    log(message: unknown, ...rest: unknown[]): void {
        this.write('info', message, rest);
    }

    error(message: unknown, ...rest: unknown[]): void {
        this.write('error', message, rest);
    }

    warn(message: unknown, ...rest: unknown[]): void {
        this.write('warn', message, rest);
    }

    debug(message: unknown, ...rest: unknown[]): void {
        this.write('debug', message, rest);
    }

    verbose(message: unknown, ...rest: unknown[]): void {
        this.write('trace', message, rest);
    }

    fatal(message: unknown, ...rest: unknown[]): void {
        this.write('fatal', message, rest);
    }

    private write(
        level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal',
        message: unknown,
        rest: unknown[],
    ): void {
        const layer = typeof rest.at(-1) === 'string' ? (rest.at(-1) as string) : 'nest';
        const text = typeof message === 'string' ? message : JSON.stringify(message);

        rootLogger.child({ layer })[level](text);
    }
}
