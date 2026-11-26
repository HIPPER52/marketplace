/**
 * The connection the application runs on. One DataSource, injected everywhere: the
 * repositories read through it, CheckoutService opens its transactions on it, and
 * /readiness pings it — so the probe answers for the pool that actually serves requests
 * rather than for a second one kept beside it.
 */
export const DATA_SOURCE = Symbol('DATA_SOURCE');
