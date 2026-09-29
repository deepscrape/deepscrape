/* eslint-disable max-len */
/**
 * Deletion tombstones.
 *
 * Disabling the Auth record stops sign-in and new tokens, and revoking refresh tokens
 * stops renewal — but an ID token already in circulation stays valid until it expires,
 * which is up to an hour. Auth offers no way to revoke an unexpired token, so the only
 * way to close that window is to check something on the read path.
 *
 * Redis rather than Firestore because this is read on **every authenticated request**
 * and on **every callable invocation**. A Firestore read there would be a billed read
 * per request, for a flag that is true for a handful of accounts at any moment.
 *
 * Deliberately one module, shared by both entry points — `authz.middleware` for the
 * Express routes and `callable-limiter` for the callables. Two copies of this check is
 * how the two entry points end up disagreeing about who is deleted.
 */

import {redis} from "../app/cacheConfig"
import {DELETED_USER_TTL_SECONDS, deletedUserKey} from "../../../src/config/redis-keys"

/**
 * Mark an account as deleted.
 *
 * Called only from the deletion path. The TTL outlives the longest possible ID-token
 * lifetime by a wide margin, so a stale token can never resurrect the account.
 *
 * @param {string} uid The account being closed.
 * @return {Promise<void>} Resolves once the tombstone is set.
 */
export const markAccountDeleted = async (uid: string): Promise<void> => {
  await redis.setex(deletedUserKey(uid), DELETED_USER_TTL_SECONDS, "1")
}

/**
 * Remove the tombstone when a deletion is cancelled inside its grace window.
 *
 * @param {string} uid The account being restored.
 * @return {Promise<void>} Resolves once the tombstone is gone.
 */
export const clearAccountDeletion = async (uid: string): Promise<void> => {
  await redis.del(deletedUserKey(uid))
}

/**
 * Whether the account behind this uid has been deleted.
 *
 * Fails OPEN on a Redis error, matching every other Redis-backed check in this codebase.
 * The authoritative controls sit underneath this one — a disabled Auth record and
 * revoked refresh tokens — and this closes the in-flight-token window on top of them.
 * Rejecting every live user's requests because Upstash blinked would be the worse
 * outage of the two.
 *
 * ponytail: one GET per authenticated request. If a deletion must be enforceable during
 * a Redis outage, back this with a Firestore read on the user document.
 *
 * @param {string} uid The caller's uid.
 * @return {Promise<boolean>} True when a deletion tombstone exists.
 */
export const isAccountDeleted = async (uid: string): Promise<boolean> => {
  try {
    const tombstone = await redis.get<unknown>(deletedUserKey(uid))
    return tombstone != null
  } catch (error) {
    console.warn("account-tombstone: read failed, treating account as live", error)
    return false
  }
}
