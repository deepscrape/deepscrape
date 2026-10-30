/* eslint-disable max-len */
/**
 * Removing an organization, and keeping one administrable when its owner leaves.
 *
 * An organization is FOUR records under TWO parent collections -- identity at
 * `organizations/{orgId}`, money at `orgs/{orgId}`, and grants in the flat
 * `memberships` and `invitations` collections. A delete that names only the
 * first leaves a spendable wallet, a roster and an owner id pointing at an
 * account that no longer exists, which is exactly what erasing an account used
 * to do. Naming all four here is what stops the next sweep missing one.
 */
import {Timestamp} from "firebase-admin/firestore"
import {db} from "../app/config"

export const ORGANIZATION_COLLECTION = "organizations"
export const ORG_DATA_ROOT = "orgs"
export const ORG_MEMBERSHIP_COLLECTION = "memberships"
export const ORG_INVITATION_COLLECTION = "invitations"

/** Rows removed per flat collection per cascade. */
const CASCADE_PAGE_LIMIT = 500
/** Orgs one departing account is assumed to own. */
const OWNED_ORG_LIMIT = 20
/** Roster read when looking for an heir. */
const ORG_MEMBER_LIMIT = 50

/**
 * The `memberships` document id for one person in one org.
 *
 * Keyed by the pair, which is what makes every membership lookup a document get
 * rather than a query. Duplicating the format in a second module is how the two
 * copies eventually disagree.
 * @param {string} uid The member.
 * @param {string} orgId The organization.
 * @return {string} The document id.
 */
export const organizationMembershipId = (uid: string, orgId: string): string =>
  `${uid}_${orgId}`

/**
 * Delete an organization and everything keyed to it.
 *
 * Every step is idempotent, so a retry after a partial run finishes the job.
 * `invitations` goes with its org deliberately: a pending invitation names an
 * org that no longer exists, and leaving it makes `listMyInvitations` offer
 * people a join that can only fail.
 *
 * shortcut: an org's stored objects are not swept here -- no org-scoped object
 * namespace exists yet. Add the prefix to `purgePrefixes` in blob-purge.ts in
 * the same commit that introduces one, or a deleted org keeps its files.
 * @param {string} orgId The organization to remove.
 * @return {Promise<void>} Resolves once nothing keyed to the org remains.
 */
export const deleteOrganizationCascade = async (
  orgId: string,
): Promise<void> => {
  await Promise.all([
    db.recursiveDelete(db.doc(`${ORGANIZATION_COLLECTION}/${orgId}`)),
    db.recursiveDelete(db.doc(`${ORG_DATA_ROOT}/${orgId}`)),
  ])

  for (const collection of [
    ORG_MEMBERSHIP_COLLECTION,
    ORG_INVITATION_COLLECTION,
  ]) {
    const page = await db.collection(collection)
      .where("orgId", "==", orgId)
      .limit(CASCADE_PAGE_LIMIT)
      .get()
    if (page.empty) continue

    const batch = db.batch()
    page.docs.forEach((doc) => batch.delete(doc.ref))
    await batch.commit()

    if (page.size === CASCADE_PAGE_LIMIT) {
      console.error(
        `CRITICAL: ${orgId} still has ${collection} rows after ` +
        `${CASCADE_PAGE_LIMIT} deletes; the cascade leaves the rest.`,
      )
    }
  }
}

/** One org whose ownership moved to a surviving member. */
export type OrganizationTransfer = {
  orgId: string
  /** The member who now owns it and is told so. */
  heirUid: string
  /** What the org is called, for the notice. */
  orgName: string
}

/** What erasing one account did to the organizations it owned. */
export type OrganizationHandover = {
  /** Orgs erased with the account, because it was their only member. */
  deletedOrgIds: string[]
  /** Orgs handed to a surviving member. */
  transferred: OrganizationTransfer[]
}

/**
 * When a membership was granted, in millis, for ordering heirs.
 *
 * Two shapes live in this field: `Timestamp.serverTimestamp()` from the auth
 * trigger and a plain `Date` from the callables. A member whose field is
 * neither sorts last rather than crashing a purge.
 * @param {object} snapshot A membership document.
 * @return {number} Epoch millis, or `MAX_SAFE_INTEGER` when unreadable.
 */
export const addedAtMillis = (
  snapshot: {get: (field: string) => unknown},
): number => {
  const value = snapshot.get("createdAt")
  const millis = (value as {toMillis?: () => number})?.toMillis?.()
  if (typeof millis === "number") return millis
  if (value instanceof Date) return value.getTime()
  return Number.MAX_SAFE_INTEGER
}

/**
 * Delete the invitations addressed to one mailbox.
 *
 * They sit in OTHER organizations' namespaces -- the ones this person was invited
 * to and never joined -- so nothing that walks their own documents can reach them,
 * and each one carries the address the erasure promised to shred. Deleted rather
 * than revoked: a revoked row still holds the address, and the org it pointed at
 * has no use for a record of an invitation to somebody who no longer exists.
 * @param {string} email The erased address, already lowercased.
 * @return {Promise<number>} How many rows were removed.
 */
export const purgeInvitationsForEmail = async (
  email: string,
): Promise<number> => {
  const page = await db.collection(ORG_INVITATION_COLLECTION)
    .where("email", "==", email)
    .limit(CASCADE_PAGE_LIMIT)
    .get()
  if (page.empty) return 0

  const batch = db.batch()
  page.docs.forEach((doc) => batch.delete(doc.ref))
  await batch.commit()

  if (page.size === CASCADE_PAGE_LIMIT) {
    console.error(
      `CRITICAL: ${page.size} invitations for an erased address remain; ` +
      "the purge deletes one page per run.",
    )
  }

  return page.size
}

/**
 * The organizations this account owns, for a notice that has to name them.
 *
 * Read at request time rather than at purge time: the point is to tell the
 * customer what the deletion will take before they confirm it, and the answer
 * stops being available once the account is locked.
 * @param {string} uid The account.
 * @return {Promise<object[]>} Each owned org's id and display name.
 */
export const listOwnedOrganizations = async (
  uid: string,
): Promise<{orgId: string; name: string}[]> => {
  const owned = await db.collection(ORG_MEMBERSHIP_COLLECTION)
    .where("userId", "==", uid)
    .where("role", "==", "owner")
    .limit(OWNED_ORG_LIMIT)
    .get()

  const orgs: {orgId: string; name: string}[] = []

  for (const membership of owned.docs) {
    const orgId = String(membership.get("orgId") || "")
    if (!orgId) continue

    const snapshot = await db.doc(`${ORGANIZATION_COLLECTION}/${orgId}`).get()
    orgs.push({orgId, name: String(snapshot.get("name") || orgId)})
  }

  return orgs
}

/**
 * Stop an org being orphaned by the erasure of the account that owns it.
 *
 * The lock phase already refuses a deletion while the owner has teammates, so
 * the transfer branch is the case that slipped in during the grace window: a
 * member added after the account was closed. Erasing the org instead would
 * destroy their data, so the longest-standing member takes it over -- chosen by
 * seniority rather than arbitrarily, so the handover is not a coin toss between
 * two admins on the same day.
 *
 * A sole-member org belongs to nobody but the departing account, so it goes with
 * them. Leaving it is the failure this function exists to end: an organization
 * whose owner id names a deleted account, whose wallet nobody can spend, and
 * whose only trace is a document support would have to find by hand.
 * @param {string} uid The account being erased.
 * @return {Promise<OrganizationHandover>} Erased and handed-over organizations.
 */
export const releaseOwnedOrganizations = async (
  uid: string,
): Promise<OrganizationHandover> => {
  const owned = await db.collection(ORG_MEMBERSHIP_COLLECTION)
    .where("userId", "==", uid)
    .where("role", "==", "owner")
    .limit(OWNED_ORG_LIMIT)
    .get()

  const handover: OrganizationHandover = {deletedOrgIds: [], transferred: []}

  for (const membership of owned.docs) {
    const orgId = String(membership.get("orgId") || "")
    if (!orgId) continue

    const members = await db.collection(ORG_MEMBERSHIP_COLLECTION)
      .where("orgId", "==", orgId)
      .limit(ORG_MEMBER_LIMIT)
      .get()

    const heir = members.docs
      .filter((doc) => doc.id !== membership.id)
      .sort((a, b) => addedAtMillis(a) - addedAtMillis(b))[0]
    const heirUid = heir ? String(heir.get("userId") || "") : ""

    if (!heir || !heirUid) {
      await deleteOrganizationCascade(orgId)
      handover.deletedOrgIds.push(orgId)
      continue
    }

    const orgSnap = await db.doc(
      `${ORGANIZATION_COLLECTION}/${orgId}`,
    ).get()

    // An org document that is already gone leaves nothing to hand over, and the
    // merge-set below would resurrect it with three fields and no name.
    if (!orgSnap.exists) {
      await deleteOrganizationCascade(orgId)
      handover.deletedOrgIds.push(orgId)
      continue
    }

    const orgName = String(
      orgSnap.get("name") || orgId,
    )

    const now = Timestamp.now()
    const batch = db.batch()
    batch.set(heir.ref, {role: "owner", updatedAt: now}, {merge: true})
    batch.set(
      db.doc(`${ORGANIZATION_COLLECTION}/${orgId}`),
      {ownerId: heirUid, billingOwnerUid: heirUid, updatedAt: now},
      {merge: true},
    )
    await batch.commit()

    handover.transferred.push({orgId, heirUid, orgName})
  }

  if (owned.size === OWNED_ORG_LIMIT) {
    console.error(
      `CRITICAL: ${uid} owns at least ${OWNED_ORG_LIMIT} organizations; any ` +
      "beyond that were not released.",
    )
  }

  return handover
}
