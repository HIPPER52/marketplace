/**
 * The limiter instance the guard uses.
 *
 * A token because the class takes its limit and window as constructor arguments rather
 * than from a decorator — the demo builds its own with a limit of five, and a class used
 * as a token would promise there is only one configuration.
 */
export const RATE_LIMITER = Symbol('RATE_LIMITER');
