/* eslint-disable object-curly-spacing */
/**
 * Holding a worker's lease.
 *
 * Why the lease cannot live in `selectWorker`
 * -------------------------------------------
 * Selection decides which worker *could* serve a call. It cannot decide whether
 * one actually will, because that answer has to be the same in every instance
 * at once: two callers in two containers reading the same idle set would both
 * be told yes and both launch a browser in one worker -- the cross-tenant leak
 * I2 forbids, reached through a race rather than through a design.
 *
 * So the claim is one atomic command, and this store is the only thing that
 * issues it. `SET key holder NX EX ttl` is already atomic; the Lua wrapper
 * exists to return the holder token rather than a status string, so a grant and
 * a refusal are distinguishable from the reply alone.
 *
 * Release is conditional, and that is not decoration
 * -------------------------------------------------
 * A bare `DEL` would be wrong. A call can outlive its own TTL -- a slow
 * navigation, a paused container -- and by then another tenant may hold the
 * key. Deleting unconditionally would revoke *their* lease and admit a third
 * caller while they are still mid-call. The script compares the holder first
 * and deletes only a lease this caller still owns.
 *
 * Both calls fail closed
 * ----------------------
 * Neither rejects: the caller is an HTTP route that has to answer, so an
 * unreachable Redis must read as "refused" rather than as an unhandled error.
 * `leaseGrantedBy` needs a real string back, so an unconfigured Redis refuses
 * instead of granting -- see its comment for why the naive version of this file
 * would have reported success with no Redis at all.
 *
 * One consequence, stated rather than discovered later: with no Redis
 * configured -- local dev and the emulator -- no lease can be taken, so a
 * pooled browser call is refused there. That is the intended behaviour. A
 * worker that cannot be proven exclusively leased is not handed out.
 */
import {redisEval} from "../app/cacheConfig"
import {
  WORKER_LEASE_TTL_SECONDS,
  leaseGrantedBy,
  workerLeaseRedisKey,
  type WorkerEntry,
} from "../domain/webrain-workers.domain"

/**
 * Claims the key only when it is free, returning the holder on success.
 *
 * Redis turns a nil bulk reply into `false` in Lua, which is why the miss path
 * tests the result rather than comparing it to nil.
 */
const CLAIM_SCRIPT = `
local taken = redis.call('SET', KEYS[1], ARGV[1], 'NX', 'EX', ARGV[2])
if taken then
  return ARGV[1]
end
return false
`

/**
 * Deletes the key only when this caller is still the holder.
 *
 * The comparison is what makes release safe after a lapse: without it, a slow
 * call finishing late would delete a lease somebody else now legitimately owns.
 */
const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`

/**
 * Take a worker for one call.
 *
 * Never rejects. `false` covers every refusal: already leased, and Redis
 * unreachable or unconfigured. The caller cannot act on the difference -- both
 * mean "do not use this worker" -- so collapsing them keeps the fail-closed
 * path impossible to get wrong at the call site.
 * @param {WorkerEntry} worker The worker being claimed.
 * @param {string} holder A token unique to this call.
 * @param {number} ttlSeconds How long the lease survives without a release.
 * @return {Promise<boolean>} True only when this call holds the lease.
 */
export const claimWorkerLease = async (
  worker: WorkerEntry,
  holder: string,
  ttlSeconds: number = WORKER_LEASE_TTL_SECONDS
): Promise<boolean> => {
  try {
    const result = await redisEval<unknown>(
      CLAIM_SCRIPT,
      [workerLeaseRedisKey(worker)],
      [holder, ttlSeconds]
    )
    return leaseGrantedBy(result)
  } catch {
    return false
  }
}

/**
 * Give a worker back, if this caller still holds it.
 *
 * Never rejects. `false` means "released nothing", which is the correct outcome
 * for a lease that already lapsed and was taken by somebody else.
 * @param {WorkerEntry} worker The worker being released.
 * @param {string} holder The token the claim was made with.
 * @return {Promise<boolean>} True only when this caller's lease was removed.
 */
export const releaseWorkerLease = async (
  worker: WorkerEntry,
  holder: string
): Promise<boolean> => {
  try {
    const result = await redisEval<unknown>(
      RELEASE_SCRIPT,
      [workerLeaseRedisKey(worker)],
      [holder]
    )
    return typeof result === "number" ? result > 0 : false
  } catch {
    return false
  }
}
