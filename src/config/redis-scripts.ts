/**
 * Lua scripts for the Redis hot paths, shared by `api/` and `functions/`.
 *
 * Why Lua: the heartbeat runs every 60s per active client and is the single
 * hottest path in the app. Each `await` on the Upstash REST client was a full
 * HTTPS round-trip, so read-then-refresh and read-then-update sequences paid
 * two or three round-trips where one script suffices. The scripts also make
 * those sequences atomic, which the previous read-modify-write code was not.
 *
 * All scripts are passed to `redis.eval(script, keys, args)`. Redis rejects an
 * `EVAL` whose declared key count does not match the keys array, so the
 * `KEYS`/`ARGV` contract documented per script is load-bearing.
 */

/**
 * Read a session and, in the same round-trip, refresh its TTL — while refusing
 * to resurrect a revoked session.
 *
 * KEYS[1] = session key
 * KEYS[2] = revocation key
 * ARGV[1] = session TTL in seconds
 *
 * Returns { payload, status } where status is:
 *   "ok"       payload is the cached session JSON (or false when absent)
 *   "revoked"  payload is the revocation JSON
 *
 * Note the deliberate ordering: `exists` on the revocation key runs first, so a
 * revoked session is reported even when a stale session payload is still
 * present in the cache. Refresh only happens for a live, present session.
 */
export const READ_SESSION_WITH_TTL_REFRESH = `
local revoked = redis.call('get', KEYS[2])
if revoked then
  return { revoked, 'revoked' }
end
local payload = redis.call('get', KEYS[1])
if payload then
  redis.call('expire', KEYS[1], ARGV[1])
end
return { payload, 'ok' }
`

/**
 * Refresh a session TTL only when the session exists.
 *
 * KEYS[1] = session key
 * ARGV[1] = TTL in seconds
 *
 * Returns 1 when the TTL was refreshed, 0 when the key was absent. The boolean
 * matters: the old code refreshed blindly, which could write a session key that
 * a concurrent sign-out had just deleted.
 */
export const REFRESH_SESSION_TTL_IF_PRESENT = `
if redis.call('exists', KEYS[1]) == 1 then
  redis.call('expire', KEYS[1], ARGV[1])
  return 1
end
return 0
`

/**
 * Heartbeat presence: mark the caller live, upsert the sorted set, trim the
 * stale tail — one round-trip instead of the previous setex + 4 zset commands.
 *
 * KEYS[1] = presence key for this caller (`user:`/`guest:` prefixed)
 * KEYS[2] = online users zset
 * KEYS[3] = online guests zset
 * ARGV[1] = presence TTL in seconds
 * ARGV[2] = presence payload (lastSeen JSON)
 * ARGV[3] = epoch ms now (score)
 * ARGV[4] = member to upsert
 * ARGV[5] = cutoff epoch ms for trimming
 * ARGV[6] = "user" or "guest" — which zset is authoritative for this caller
 *
 * ponytail: the two `zcount`s that used to be returned here are gone — the caller
 * discarded both (`void activeUsersNow`). Population counts are owned by
 * computeActiveUsersNow via PRESENCE_WINDOW_COUNTS, once a minute, where they are
 * actually read. Counting on the app's hottest endpoint for a thrown-away value
 * was work on every single heartbeat.
 */
export const HEARTBEAT_PRESENCE = `
redis.call('setex', KEYS[1], ARGV[1], ARGV[2])
if ARGV[6] == 'user' then
  redis.call('zadd', KEYS[2], ARGV[3], ARGV[4])
else
  redis.call('zadd', KEYS[3], ARGV[3], ARGV[4])
end
redis.call('zremrangebyscore', KEYS[2], 0, ARGV[5])
redis.call('zremrangebyscore', KEYS[3], 0, ARGV[5])
return 1
`

/**
 * Multi-window presence counts for the scheduled active-user rollup.
 *
 * KEYS[1] = online users zset
 * KEYS[2] = online guests zset
 * ARGV[i] = lower bound in epoch ms for window i (ARGV[1] = 1 minute, ...)
 * ARGV is paired with a matching `now` upper bound appended last.
 *
 * Returns a flat array { users1m, guests1m, users5m, guests5m, users30m, guests30m }
 * where the windows are supplied in ascending width order.
 */
export const PRESENCE_WINDOW_COUNTS = `
local out = {}
for i = 1, #ARGV - 1 do
  local lower = ARGV[i]
  table.insert(out, redis.call('zcount', KEYS[1], lower, ARGV[#ARGV]))
  table.insert(out, redis.call('zcount', KEYS[2], lower, ARGV[#ARGV]))
end
return out
`

/**
 * Merge a patch into a cached JSON session payload, atomically, and refresh the
 * TTL — but only when the session is still cached.
 *
 * KEYS[1] = session key
 * ARGV[1] = JSON object of the fields to merge
 * ARGV[2] = session TTL in seconds
 *
 * Returns the refreshed payload, or false when the key had expired.
 *
 * Why the guard matters: the previous implementation was a `get` in Node
 * followed by a `setex`, so a key that expired in between was re-created from
 * whatever this caller happened to be holding — resurrecting a session that
 * Firestore had already marked inactive.
 */
export const MERGE_SESSION_CACHE = `
if redis.call('exists', KEYS[1]) == 0 then
  return false
end
local guard = 0
local payload = redis.call('get', KEYS[1])
if not payload then
  return false
end
local decoded = cjson.decode(payload)
local patch = cjson.decode(ARGV[1])
for field, value in pairs(patch) do
  decoded[field] = value
end
local encoded = cjson.encode(decoded)
if type(encoded) ~= 'string' then
  return false
end
redis.call('setex', KEYS[1], ARGV[2], encoded)
return encoded
`

/**
 * Fixed-window counter used for abuse budgets (verification codes). Atomic
 * where the previous `get` + `setex` pair was not: two concurrent requests
 * could each read the same count and both be admitted.
 *
 * KEYS[1] = counter key
 * ARGV[1] = window length in seconds
 *
 * Returns { count, ttlSeconds } where ttlSeconds is -1 once the window opened.
 */
export const FIXED_WINDOW_INCREMENT = `
local count = redis.call('incr', KEYS[1])
if count == 1 then
  redis.call('expire', KEYS[1], ARGV[1])
end
local ttl = redis.call('ttl', KEYS[1])
return { count, ttl }
`
