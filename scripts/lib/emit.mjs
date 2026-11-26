/**
 * One line, one fact: `key=value`, kebab-case keys, ASCII.
 *
 * It is the contract every demo in this repository has printed since #19, and it is read
 * by a machine with `grep -qx`, so a near miss is a miss — `no_token` is not `no-token`.
 * Where an assignment names a key, that name is used verbatim and is not improved upon.
 */
export function emit(key, value) {
    console.log(`${key}=${value}`);
}

/** Fails the process with a sentence, after the numbers have already been printed. */
export function fail(message) {
    console.error(`\n${message}\n`);
    process.exitCode = 1;
}
