/**
 * Compare-and-delete: remove this key only if it still holds my token.
 *
 * A bare `DEL` does not ask whose lock it is. Between "my lock expired" and "I am
 * releasing it" there is room for somebody else's `SET … NX` to succeed, and the `DEL`
 * that follows deletes *their* lock — mutual exclusion gone, silently, at exactly the
 * moment it was needed. The lecture does this live with two redis-cli sessions.
 *
 * Lua rather than `DELEX key IFEQ token`, which arrived in Redis 8.4 and would work on
 * this stand: this runs on any version, and it is the same guarantee. It is atomic for the
 * reason every Lua script here is atomic — the server is single-threaded, so while the
 * script runs nobody else gets in. That is a property of Redis, not a feature of EVAL.
 */
export const COMPARE_AND_DELETE = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
else
  return 0
end
`;
