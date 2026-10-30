/* eslint-disable object-curly-spacing */
/**
 * The caller's plan, read the same way the request middleware reads it.
 *
 * Why this is a module rather than a local helper
 * ----------------------------------------------
 * Two callers need it and they must agree: a settings callable that writes on
 * behalf of the caller, and the scheduled job runtime, which has NO request and
 * therefore no `req.accessMode` to inherit. A second copy of this read is how the
 * two would come to disagree about a grace period or a lapsed plan -- and the
 * divergence would show up as work running for an account that had already been
 * downgraded.
 *
 * Deliberately not cached: a plan can change between two calls, and a stale
 * entitlement is how a downgraded account keeps a paid feature.
 */
import { getBillingAccessMode } from "../domain/billing.domain"
import { db } from "../app/config"

/**
 * The access mode for one account.
 * @param {string} uid The account.
 * @return {Promise<string>} `free`, `credits`, `plan`, `grace` or `unlimited`.
 */
export const accessModeOf = async (uid: string): Promise<string> => {
  const snapshot = await db
    .collection("users")
    .doc(uid)
    .collection("billing")
    .doc("current")
    .get()

  if (!snapshot.exists) {
    return getBillingAccessMode(undefined)
  }
  return getBillingAccessMode(snapshot.data())
}
