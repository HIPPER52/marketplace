import { spawnSync } from 'node:child_process';

/**
 * Running a command and reading what it said, without a shell in the middle.
 *
 * `spawnSync` with an argument array rather than a command string: nothing here needs
 * word splitting, and the day one of these arguments contains a space is not the day to
 * find out that it did.
 *
 * 64 MB of buffer because two callers are not interactive output — `docker save` of a
 * whole image and the scanner's JSON report both run past the 1 MB default, and the
 * failure mode is a truncated stdout that parses as nothing.
 */
const MAX_BUFFER = 64 * 1024 * 1024;

/** Named, because every helper below returns it and two demos destructure it. */
export class CommandResult {
    constructor(code, stdout, stderr) {
        this.code = code;
        this.stdout = stdout;
        this.stderr = stderr;
    }

    get output() {
        return `${this.stdout}${this.stderr}`;
    }
}

export function run(command, args, options = {}) {
    const result = spawnSync(command, args, {
        encoding: 'utf8',
        maxBuffer: MAX_BUFFER,
        ...options,
    });

    if (result.error) {
        throw new Error(`${command} could not be started: ${result.error.message}`);
    }

    return new CommandResult(result.status ?? 1, result.stdout ?? '', result.stderr ?? '');
}

/** The same, for the calls where a non-zero exit is a bug rather than an answer. */
export function must(command, args, options = {}) {
    const result = run(command, args, options);

    if (result.code !== 0) {
        throw new Error(
            `${command} ${args.join(' ')} exited ${result.code}\n${result.output.trim()}`,
        );
    }

    return result.stdout;
}

export function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
