/**
 * The paths pino replaces before a line is written, and the sentence that goes with them:
 * **redact hides exactly what it was told to hide, and guesses nothing.**
 *
 * `*.token` matches `x.token` and not `x.y.token` — one level, not any depth. A nested
 * object whose path is not in this list travels into the log in full, which is why the
 * rule in this project is the other way round: nothing logs a request body, and this list
 * is the safety net for the day something does.
 *
 * `demo:logs` sends a bearer token with a marker in it and a password with another, and
 * prints `secret-in-logs=0`. The token is the one redact actually works on — it rides in
 * a header this service does log. The password is never handed to the logger at all,
 * which is the stronger guarantee and the one worth preferring.
 */
export const REDACT_PATHS = [
    'req.headers.authorization',
    'req.headers.cookie',
    'headers.authorization',
    'authorization',
    'password',
    'body.password',
    '*.password',
    '*.token',
    'token',
    'refreshToken',
    'accessToken',
];

export const REDACT_CENSOR = '[REDACTED]';
