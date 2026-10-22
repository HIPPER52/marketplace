/**
 * A sliding window, in one round trip.
 *
 * One script and not three commands, and this is the difference between a limiter and a
 * limiter-shaped object. Written as `ZREMRANGEBYSCORE` → `ZCARD` → `ZADD` from the
 * application, a second process fits between the count and the add: both read "four used,
 * limit five", both add, and six requests pass a limit of five. The leak appears exactly
 * under load, which is the only time the limit matters.
 *
 * It is atomic because Redis is single-threaded — while this runs, nothing else does. That
 * is the same property the compare-and-delete relies on, used here for a different reason:
 * there the atomicity was an optimisation, here it is the correctness of the limit.
 *
 * Returns `{ allowed, remaining, retryAfterMs }`. Lua has no booleans on the wire, so
 * `allowed` is 1 or 0.
 */
export const SLIDING_WINDOW = `
local key    = KEYS[1]
local now    = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit  = tonumber(ARGV[3])
local member = ARGV[4]

-- Everything older than the window never happened, as far as this decision goes.
redis.call('ZREMRANGEBYSCORE', key, 0, now - window)

local used = redis.call('ZCARD', key)

if used < limit then
  redis.call('ZADD', key, now, member)
  -- Re-armed on every admission: a key nobody uses should disappear on its own rather
  -- than wait for an eviction policy this instance deliberately does not have.
  redis.call('PEXPIRE', key, window)
  return {1, limit - used - 1, 0}
end

-- Refused. The allowance frees up when the oldest request in the window falls out of it,
-- which is a real number rather than "try again later".
local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
local retry  = window - (now - tonumber(oldest[2]))

if retry < 1 then retry = 1 end

return {0, 0, retry}
`;
