/* eslint-disable max-len */
/* eslint-disable object-curly-spacing */
/**
 * Erasing a caller's stored objects when their account is purged.
 *
 * Why a sweep rather than a stored list of keys
 * --------------------------------------------
 * The object keys are DERIVED (`userObjectKeyPrefix` hashes the uid), exactly
 * like the per-uid secret ids in `account-secrets.domain.ts`. So this needs
 * nothing from Firestore and cannot be defeated by a pointer that was already
 * deleted -- which is the failure mode that left `storage-byob-<uid>` behind
 * when the purge only read `apikeys`. Derivation is also what makes a
 * prefix-match SAFE: `users/<sha256(uid)>/` is a function of ONE uid, so it
 * cannot overlap another account's namespace.
 *
 * Why the shared tier is NOT swept
 * -------------------------------
 * `shared/` is keyed by URL and answers every caller who asks for that URL. It
 * is a cache of public fetches, not this account's data, and deleting it would
 * break reads for people who are not being deleted.
 *
 * Why a BYOB caller's bucket is NOT swept
 * --------------------------------------
 * When a caller brings their own bucket the objects are theirs, in their own
 * account. We hold a credential that lets us read and write them; we do not
 * hold ownership, and an erasure request here is not a mandate to reach into a
 * third party's storage and delete. Only the platform bucket is ours to clean.
 */
import {LIST_LIMIT, userObjectKeyPrefix} from "../domain/storage-scope.domain"
import type {BlobStore} from "./blob-store.port"
import {getPlatformBlobStore} from "./platform-blob-store"

/**
 * Pages a purge will walk before giving up on one account.
 *
 * A ceiling rather than an unbounded loop, because this runs inside a scheduled
 * function that has a timeout and a batch of other accounts behind it. Running
 * out of budget is logged rather than silently truncating, so an account that
 * really does hold more than this is visible instead of assumed clean.
 */
export const BLOB_PURGE_MAX_PAGES = 25

/**
 * Delete every object one caller owns in the platform bucket.
 *
 * Best-effort by contract: returns what it removed and lets a genuine failure
 * propagate, so the caller decides whether it is fatal. The purge treats an
 * object-store outage as one account's problem, never as a reason to skip
 * everyone else's erasure -- the same rule the secret loop follows.
 *
 * `store` is a PARAMETER rather than a lookup, for the reason
 * `planWorkerAcquisition` takes its pool the same way: supply is not this
 * module's business, and a caller that resolves it here cannot be tested without
 * an emulator. The default resolves the platform bucket, so production callers
 * pass one argument and a spec passes a fake.
 * @param {string} uid The account being erased.
 * @param {BlobStore | null} store The platform store, or null when none exists.
 * @return {Promise<number>} How many objects were deleted.
 */
export const purgeAccountBlobs = async (
  uid: string,
  store: BlobStore | null = getPlatformBlobStore(),
): Promise<number> => {
  if (!store) {
    // No platform bucket is configured, so nothing of ours can be holding this
    // account's bytes. A complete answer, not a failure to have tried.
    return 0
  }

  const prefix = userObjectKeyPrefix(uid)
  let deleted = 0

  for (let page = 0; page < BLOB_PURGE_MAX_PAGES; page += 1) {
    const batch = await store.list(prefix, LIST_LIMIT)

    for (const blob of batch) {
      await store.delete(blob.key)
      deleted += 1
    }

    // A short page means the namespace is exhausted. Without this the loop would
    // spend its whole budget on an empty listing.
    if (batch.length < LIST_LIMIT) {
      return deleted
    }
  }

  console.warn(
    `Blob purge hit its page ceiling (${BLOB_PURGE_MAX_PAGES}) for ${uid}; ` +
    `${deleted} objects deleted so far.`,
  )
  return deleted
}
