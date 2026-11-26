/**
 * The names three different systems have to agree on, in one file.
 *
 * A metric name is read by `/metrics`, by the PromQL in the committed dashboard and by
 * `demo:metrics`, which parses the exposition text. A typo in one of those three places
 * is a panel that is empty for ever and a demo that quietly measures nothing.
 */
export const SERVICE_NAME = 'marketplace-api';

/** Operational, like /health and /readiness, and outside the contract for the same reason. */
export const METRICS_PATH = '/metrics';

export const HTTP_REQUESTS_TOTAL = 'http_requests_total';
export const HTTP_REQUEST_DURATION = 'http_request_duration_seconds';

/**
 * The label set, and the whole of the cardinality decision.
 *
 * `route` is the **template** — `/orders/:orderId`, never `/orders/8ca1…`. A label whose
 * value the caller chooses is not a field and not a string: it is a separate time series
 * with its own memory, for ever. Measured in `demo:metrics`: a hundred order ids through
 * a templated route add **no** new series; through a raw path they would add a hundred.
 */
export const METRIC_LABELS = ['method', 'route', 'status'] as const;

/**
 * Bucket boundaries, in seconds, and the reason the top one is five.
 *
 * `histogram_quantile` interpolates **inside** a bucket and cannot see past the last
 * finite `le` at all: everything above it lands in `+Inf`, and the quantile then stops at
 * the boundary and reports a number that looks healthy exactly when it is not. So the top
 * finite bucket has to be above the worst case rather than above the typical one — the
 * slowest thing this service does is a checkout that retried a serialization failure, and
 * five seconds is well past it. `demo:metrics` prints `above-top-bucket`, which is
 * `_count` minus `_bucket{le="5"}`, and it must be zero.
 */
export const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];

/** What the route label says when nothing matched — one series, not one per 404. */
export const UNMATCHED_ROUTE = '<unmatched>';
