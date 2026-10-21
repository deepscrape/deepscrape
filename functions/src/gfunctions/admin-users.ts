/* eslint-disable max-len */
/**
 * Account lifecycle: admin control over user accounts, and self-service deletion.
 *
 * The shape of this file follows one rule that is not negotiable in a SaaS platform:
 * **nothing erases an account synchronously.** Every path — the user's own request and
 * a platform admin's action alike — converges on the same three phases:
 *
 *   1. request     the user asks, and proves control of the mailbox they signed up with
 *   2. lock + flag  credentials are revoked, the account is disabled, a purge deadline
 *                   is set. Nothing is destroyed. Support can still restore it.
 *   3. purge       a scheduled job, days later, erases the data and the Auth record
 *
 * Why the delay is not optional:
 *   - A deletion request can be coerced (a stolen session, a borrowed laptop, a
 *     disgruntled employee). Days of recoverable state turn that into a support ticket
 *     instead of a data-loss incident.
 *   - Disputes and chargebacks arrive weeks after the fact. An account that vanishes
 *     the same second it is asked to has no evidence trail left to answer them with.
 *   - It is the only way to keep the audit record. A synchronously-deleted account has
 *     no record that it was ever deleted, by whom, or on what authority.
 *
 * Two things are deliberately NOT here:
 *   - **Role changes.** `setDefaultRole` / `setRoleClaim` already own claims, and a
 *     hand-editable admin toggle is a privilege-escalation path with a much larger blast
 *     radius than "lock this account". It deserves its own review, not a checkbox
 *     bolted onto the destructive page.
 *   - **Org-member removal.** Removing someone from your organization is
 *     `organization:manage` on a membership and lives in the org handlers. It must
 *     never be confused with deleting the person: an org admin has no consent from, and
 *     no visibility into, the rest of that human's data.
 */

import {createHash, randomInt, timingSafeEqual} from "node:crypto"
import {Timestamp} from "firebase-admin/firestore"
import {onSchedule} from "firebase-functions/v2/scheduler"
import {HttpsError} from "firebase-functions/v2/https"
import {z} from "zod"
import {
  auth as adminAuth,
  db,
  getStripe,
  purgeSecretAndAllRevisions,
  secretPathFor,
  stripeSecrets,
} from "../app/config"
import {redis, redisEval} from "../app/cacheConfig"
import {env, functionsEnvJson} from "../config/env"
import {guardedOnCall as onCall} from "../infrastructure/callable-limiter"
import {validateCallableData} from "../infrastructure/validate"
import {clearAccountDeletion, markAccountDeleted} from "../infrastructure/account-tombstone"
import {renderEmail, renderEmailText, sendEmail} from "../infrastructure/email"
import {purgeAccountBlobs} from "../infrastructure/blob-purge"
import {accountSecrets} from "../domain/account-secrets.domain"
import {canPerform} from "../domain/authz.domain"
import {
  DELETION_CONFIRMATION_CODE_LENGTH,
  DELETION_CONFIRMATION_TTL_HOURS,
  RETENTION_SUBCOLLECTIONS,
  buildErasedUserRecord,
  erasedAuthEmail,
  evaluateAccountDeletionEligibility,
  isPurgeDue,
  resolvePurgeAfter,
  type AccountDeletionActor,
  type RetainedAccountData,
} from "../domain/account-deletion.domain"
import {performSessionRevoke, resolveActorSessionAccess, type ActorSessionAccess} from "./sessions"
import {
  ACCOUNT_DELETION_ATTEMPT_MAX,
  ACCOUNT_DELETION_ATTEMPT_WINDOW_SECONDS,
  ACCOUNT_DELETION_REQUEST_MAX,
  ACCOUNT_DELETION_REQUEST_WINDOW_SECONDS,
  accountDeletionAttemptKey,
  accountDeletionRequestKey,
} from "../../../src/config/redis-keys"
import {FIXED_WINDOW_INCREMENT} from "../../../src/config/redis-scripts"

const CALLABLE_OPTIONS = {
  cors: true,
  enforceAppCheck: true,
  secrets: [functionsEnvJson],
  // `as const` on the object would make `secrets` a readonly tuple, which
  // CallableOptions does not accept; the literal unions are pinned per property instead.
  region: "us-central1" as const,
}

/** Accounts erased per purge run. See the ceiling note on `purgeDeletedAccounts`. */
const PURGE_BATCH_SIZE = 25

/** Cap on sessions revoked in one batch set. */
const SESSIONS_PER_REVOKE = 500

/** Projection of the user document this module reads. Deliberately partial. */
type UserDoc = {
  email?: string | null
  username?: string
  role?: string
  stripeId?: string
  subscriptionId?: string
  plan?: string
  planInterval?: string
  status?: string
  balance?: number
  currentUsage?: number
  itemId?: string
  created_At?: unknown
  profileStatus?: {
    isBanned?: boolean
    isDeleted?: boolean
    banReason?: string
    deleteReason?: string
    banExpires?: Date | null
    deletedAt?: Date | null
    purgeAfter?: Date | null
    purgedAt?: Date | null
    deletedBy?: string | null
    deletionId?: string | null
  }
  notifications?: { securityAlerts?: boolean }
} | undefined

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Fixed-window counter for one budget. Fails open when Redis is unavailable, matching
 * every other limiter in this codebase — the account-level controls (a verified ID
 * token, a hashed confirmation code, an attempt budget that survives a Redis blip) are
 * what actually protect these paths.
 *
 * @param {string} key Counter key, declared in redis-keys.ts.
 * @param {number} max Invocations allowed inside the window.
 * @param {number} windowSeconds Window length.
 * @param {string} message Client-facing message when exhausted.
 */
const enforceBudget = async (
  key: string,
  max: number,
  windowSeconds: number,
  message: string,
): Promise<void> => {
  // The counter read is the ONLY part that may fail open. The refusal below is
  // deliberately outside this try: wrapping the whole body would catch our own
  // `resource-exhausted` and silently turn the budget into a no-op.
  let count: number
  try {
    const [value] = await redisEval<[number, number]>(
      FIXED_WINDOW_INCREMENT,
      [key],
      [windowSeconds],
    )
    count = value
  } catch (error) {
    // Fail OPEN, as this helper's docblock has always promised -- and here the
    // promise is load-bearing rather than convenient: these paths include account
    // ERASURE, so an Upstash incident must not become a GDPR-erasure outage. The
    // account-level controls (a verified ID token, a hashed confirmation code)
    // are what actually protect the path; a Redis blink losing the counter is
    // survivable, a legal deadline slipping is not.
    console.error(
      `CRITICAL: budget check ${key} unavailable, allowing the request:`,
      error,
    )
    return
  }

  if (count > max) {
    throw new HttpsError("resource-exhausted", message)
  }
}

/**
 * Resolve the caller's privileges.
 *
 * `fresh` skips the 60s role cache and is used for every destructive operation: with
 * the cache, a just-demoted admin keeps the ability to erase accounts for up to a
 * minute.
 *
 * @param {*} request The callable request.
 * @param {object} options `fresh` bypasses the cached role resolution.
 * @return {Promise<ActorSessionAccess>} The caller's resolved role.
 */
const resolveCallerAccess = async (
  request: { auth?: { uid: string; token: Record<string, unknown> } | null },
  options: { fresh?: boolean } = {},
): Promise<ActorSessionAccess> => {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "You must be signed in.")
  }

  return resolveActorSessionAccess(request.auth, options)
}

const isPlatformAdminRole = (role: ActorSessionAccess["role"]): boolean =>
  role === "admin" || role === "superadmin"

/**
 * Authorize an action on a specific account through the shared policy engine.
 *
 * Routing through `canPerform` rather than a hand-rolled `if (isAdmin)` is what keeps
 * the answer to "who can delete an account" in one place — `authz.domain.ts` — where
 * it is already unit-tested. The policy grants `account:delete` to `self` only, and
 * to platform admins through `canPerform`'s admin short-circuit. No org role is
 * granted anything here, so a tenant admin cannot reach another human's account.
 *
 * @param {object} caller Resolved caller identity and privileges.
 * @param {string} caller.uid Caller uid.
 * @param {boolean} caller.isPlatformAdmin Whether the caller is platform staff.
 * @param {"read" | "suspend" | "delete"} action Action being attempted.
 * @param {string} targetUid The account being acted on.
 * @param {string} message Error text if denied.
 */
const assertAccountPermission = (
  caller: { uid: string; isPlatformAdmin: boolean },
  action: "read" | "suspend" | "delete",
  targetUid: string,
  message: string,
): void => {
  const allowed = canPerform(
    {uid: caller.uid, isPlatformAdmin: caller.isPlatformAdmin, memberships: {}},
    "account",
    action,
    {ownerId: targetUid},
  )

  if (!allowed) {
    throw new HttpsError("permission-denied", message)
  }
}

/**
 * Refuse an admin action aimed at the caller's own account.
 *
 * Not a safety check on data — it is a check on the audit trail. "Admin X suspended
 * admin X" is indistinguishable after the fact from an account compromise or a
 * privilege misconfiguration, and the person who could explain it has just locked
 * themselves out.
 *
 * @param {string} callerUid Caller uid.
 * @param {string} targetUid The account being acted on.
 */
const assertNotSelfTargeted = (callerUid: string, targetUid: string): void => {
  if (callerUid === targetUid) {
    throw new HttpsError(
      "failed-precondition",
      "Use the account settings page to close your own account, so the action is recorded as self-service.",
    )
  }
}

/**
 * Whether this address is a configured bootstrap admin.
 *
 * @param {string | null | undefined} email Address to test.
 * @return {boolean} True when the address is listed in ADMIN_EMAILS.
 */
const isBootstrapAdminEmail = (email?: string | null): boolean => {
  if (!email) return false
  const normalized = email.trim().toLowerCase()
  return env.ADMIN_EMAILS.some((adminEmail) => adminEmail.toLowerCase() === normalized)
}

/**
 * One-line audit record for an account-lifecycle action.
 *
 * `admin_audit` is append-only from the client's perspective: `firestore.rules` grants
 * platform admins read and nobody write. Only the Admin SDK reaches it, so the record
 * cannot be edited by the party it describes.
 *
 * @param {Record<string, unknown>} entry Action, actor, target and reason.
 * @return {Promise<string>} The audit document id.
 */
const writeAdminAudit = async (entry: Record<string, unknown>): Promise<string> => {
  const ref = await db.collection("admin_audit").add({
    ...entry,
    at: Timestamp.now(),
  })

  return ref.id
}

/**
 * `user@example.com` -> `u***@example.com`. Never echo a full address back.
 *
 * @param {string} email The address to mask.
 * @return {string} The masked address, or `***` when it is not an address at all.
 */
const maskEmail = (email: string): string => {
  const [local, domain] = email.split("@")
  if (!domain) return "***"
  return `${local.slice(0, 1)}***@${domain}`
}

const hashDeletionCode = (uid: string, code: string): string =>
  createHash("sha256").update(`${uid}:${code}:${env.COOKIE_SECRET}`).digest("hex")

/**
 * Normalise a stored timestamp for the client.
 *
 * Callable return values go through the framework's serializer, which turns a Firestore
 * `Timestamp` into `{_seconds, _nanoseconds}` — a shape no template can format and every
 * consumer would have to know about. ISO strings cross the boundary as themselves.
 *
 * @param {unknown} value A Timestamp, Date, string, or nothing.
 * @return {string | null} An ISO-8601 string, or null when there is no usable value.
 */
const toIso = (value: unknown): string | null => {
  if (!value) return null
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString()

  if (typeof value === "object" && typeof (value as {toDate?: () => Date}).toDate === "function") {
    const date = (value as {toDate: () => Date}).toDate()
    return Number.isNaN(date.getTime()) ? null : date.toISOString()
  }

  if (typeof value === "string") return value
  if (typeof value === "number") return new Date(value).toISOString()

  return null
}

/**
 * Deliver a deletion notice.
 *
 * Email is sent **inline** rather than through the `users/{uid}/alerts` fan-out, and
 * that is deliberate on two counts:
 *
 *   - The fan-out resolves the recipient from the Auth record. By the time a deletion
 *     is recorded, that address has already been rewritten to an undeliverable
 *     placeholder, so the notice would be sent into the void.
 *   - Erasure notice is a legal communication, not a preference-driven alert. The
 *     fan-out honours `notifications.securityAlerts === false`; this path must not,
 *     or a user who muted security alerts could be erased without ever being told.
 *
 * The alert document is still written, for the in-app bell and web push. The fan-out
 * sends no email for an unrecognised category, so there is no double-send.
 *
 * @param {object} params Recipient, content and the in-app alert copy.
 */
const notifyAccountNotice = async (params: {
  uid: string
  to: string | null
  subject: string
  content: Parameters<typeof renderEmail>[0]
  alertCategory: string
  alertTitle: string
  alertMessage: string
}): Promise<void> => {
  const work: Promise<unknown>[] = []

  if (params.to) {
    work.push(sendEmail({
      to: params.to,
      subject: params.subject,
      html: renderEmail(params.content),
      text: renderEmailText(params.content),
      fromName: "deepscrape Accounts",
    }))
  }

  work.push(db.collection("users").doc(params.uid).collection("alerts").add({
    category: params.alertCategory,
    title: params.alertTitle,
    message: params.alertMessage,
    severity: "critical",
    createdAt: Timestamp.now(),
  }))

  // Neither is allowed to fail the operation: the audit record is the authoritative
  // notice, and an account must not stay live because Resend was down.
  await Promise.allSettled(work)
}

/**
 * Cancel every Stripe subscription on the account.
 *
 * Runs **before** the lockout, and its failure aborts the deletion. That ordering is
 * the whole point: a locked-out account that is still being charged is a chargeback
 * with extra steps. An account with no subscription never touches Stripe, so
 * environments without Stripe configured are unaffected.
 *
 * Saved cards are deliberately left alone: this phase is reversible, and detaching them
 * here destroyed them for anyone who cancelled inside the grace window. `purgeOneAccount`
 * deletes the whole Stripe customer once the deletion is final.
 *
 * @param {string} uid Account being closed.
 */
const cancelStripeBilling = async (uid: string): Promise<void> => {
  const secret: string | undefined = stripeSecrets.find((item) => item.name === "STRIPE_SECRET_KEY")?.value()

  const [billingSnap, userSnap] = await Promise.all([
    db.collection(`users/${uid}/billing`).limit(10).get(),
    db.collection("users").doc(uid).get(),
  ])

  const subscriptionIds = new Set<string>()
  for (const billingDoc of billingSnap.docs) {
    const subscriptionId = billingDoc.get("subscriptionId")
    if (typeof subscriptionId === "string" && subscriptionId) subscriptionIds.add(subscriptionId)
  }

  // The user document carries a mirror of the subscription id; the two are written by
  // different code paths, so either may be the only populated one.
  const docSubscriptionId = userSnap.get("subscriptionId")
  if (typeof docSubscriptionId === "string" && docSubscriptionId) subscriptionIds.add(docSubscriptionId)

  if (subscriptionIds.size === 0) return

  if (!secret) {
    throw new HttpsError(
      "failed-precondition",
      "Billing is not configured, so an existing subscription cannot be confirmed cancelled. Contact support.",
    )
  }

  const stripe = getStripe(secret)

  for (const subscriptionId of subscriptionIds) {
    try {
      await stripe.subscriptions.cancel(subscriptionId)
    } catch (error) {
      // Already cancelled or deleted upstream is the state we wanted.
      const code = (error as { code?: string })?.code
      if (code === "resource_missing") continue
      console.error(`Failed to cancel subscription ${subscriptionId} for ${uid}:`, error)
      throw new HttpsError(
        "unavailable",
        "Could not cancel the active subscription. Nothing was deleted — please retry shortly.",
      )
    }
  }
}

/**
 * Delete the Stripe customer once the deletion is final.
 *
 * Stripe keeps the name, email and phone captured at onboarding, and deleting the
 * customer also cancels any subscription that survived the earlier cancel. Doing this at
 * purge rather than at request time is what keeps the reversible phase reversible.
 * @param {string} uid Account being erased.
 * @param {string | undefined} customerId Stripe customer id from the user document.
 * @return {Promise<boolean>} Whether Stripe now holds no customer for this account.
 */
async function deleteStripeCustomer(uid: string, customerId: string | undefined): Promise<boolean> {
  const secret: string | undefined = stripeSecrets.find((item) => item.name === "STRIPE_SECRET_KEY")?.value()
  if (!secret || !customerId) return false

  try {
    await getStripe(secret).customers.del(customerId)
    return true
  } catch (error) {
    // A customer that is already gone is the state we wanted, and the purge is retry-safe.
    if ((error as { code?: string })?.code === "resource_missing") return true
    console.error(`CRITICAL: failed to delete Stripe customer for erased account ${uid}:`, error)
    return false
  }
}

/**
 * Mark every active login session for an account as revoked.
 *
 * No per-session Redis tombstone is written, unlike the interactive revoke path. It
 * would be redundant: the account-level deletion tombstone supersedes every session
 * flag, and Auth `disabled: true` stops new tokens. The Firestore rows are still
 * updated because the admin UI reads them.
 *
 * @param {string} uid Account being closed.
 * @param {string} actorUid Who ended the sessions.
 * @return {Promise<number>} How many sessions were revoked.
 */
const revokeActiveSessions = async (uid: string, actorUid: string): Promise<number> => {
  const snapshot = await db
    .collection("loginSessions")
    .where("userId", "==", uid)
    .where("active", "==", true)
    .limit(SESSIONS_PER_REVOKE)
    .get()

  if (snapshot.empty) return 0

  // One shared revoke path. The lighter copy that lived here left the Redis session cache
  // warm and every device still trusted, so a deleted account kept a 90-day reauth bypass.
  const batch = db.batch()
  const pipeline = redis.pipeline()

  for (const sessionDoc of snapshot.docs) {
    await performSessionRevoke(
      actorUid,
      sessionDoc.id,
      "account_deletion",
      false,
      true,
      actorUid === uid ? "user" : "admin",
      true,
      {batch, pipeline, sessionData: sessionDoc.data()},
    )
  }

  await batch.commit()
  await pipeline.exec()

  if (snapshot.size === SESSIONS_PER_REVOKE) {
    console.error(
      `CRITICAL: account ${uid} hit the ${SESSIONS_PER_REVOKE}-session revoke cap; active sessions remain.`
    )
  }

  return snapshot.size
}

/**
 * How many accounts currently hold the platform-admin claim.
 *
 * Capped at two reads because the only question ever asked is "is there another one",
 * and the failure direction is safe: an unexpected `0` makes the deletion of an admin
 * *more* restricted, never less.
 *
 * @return {Promise<number>} Admin count, at most 2.
 */
const countPlatformAdmins = async (): Promise<number> => {
  const snapshot = await db.collection("users").where("role", "==", "admin").limit(2).get()
  return snapshot.size
}

/**
 * Organizations this account solely owns while other members remain.
 *
 * Erasing such an account would strand live teammates under an owner that no longer
 * exists: nobody can administer the org, and if it holds a subscription it keeps
 * billing. Ownership transfer is a deliberate human decision, so deletion is refused
 * until it happens.
 *
 * Other members are counted by filtering in memory rather than with a `!=` query,
 * which would demand a composite index for a check that runs once per deletion.
 *
 * @param {string} uid Account being closed.
 * @return {Promise<string[]>} Org ids that block the deletion.
 */
const findSoleOwnedSharedOrgs = async (uid: string): Promise<string[]> => {
  const ownedSnapshot = await db
    .collection("memberships")
    .where("userId", "==", uid)
    .where("role", "==", "owner")
    .limit(20)
    .get()

  if (ownedSnapshot.empty) return []

  const blocked: string[] = []

  for (const membership of ownedSnapshot.docs) {
    const orgId = String(membership.get("orgId") || "")
    if (!orgId) continue

    const membersSnapshot = await db
      .collection("memberships")
      .where("orgId", "==", orgId)
      .limit(50)
      .get()

    const hasOtherMember = membersSnapshot.docs.some((doc) => String(doc.get("userId") || "") !== uid)
    if (hasOtherMember) blocked.push(orgId)
  }

  return blocked
}

/**
 * Read the fields erasure retains, from a user document.
 *
 * @param {UserDoc} userData The account's document data.
 * @return {RetainedAccountData} The billing and audit slice that survives erasure.
 */
const pickRetained = (userData: UserDoc): RetainedAccountData => ({
  created_At: userData?.created_At ?? null,
  stripeId: userData?.stripeId,
  subscriptionId: userData?.subscriptionId,
  plan: userData?.plan,
  planInterval: userData?.planInterval,
  status: userData?.status,
  balance: userData?.balance,
  currentUsage: userData?.currentUsage,
  itemId: userData?.itemId,
  profileStatus: userData?.profileStatus,
})

// ---------------------------------------------------------------------------
// Phase 2 — lock and flag
// ---------------------------------------------------------------------------

/**
 * Take an account out of service without destroying it.
 *
 * Idempotent-ish by rejection: an already-deleted account is refused by the eligibility
 * check rather than silently re-processed, so a retried call cannot reset a purge
 * deadline that support has already been told about.
 *
 * @param {object} params Target, actor and reason.
 * @return {Promise<object>} The deletion id and the purge deadline.
 */
async function performAccountDeletion(params: {
  targetUid: string
  actor: AccountDeletionActor
  deletedBy: string
  reason?: string
}): Promise<{ deletionId: string; purgeAfter: string; sessionsRevoked: number }> {
  const {targetUid, actor, deletedBy, reason} = params

  const userRef = db.collection("users").doc(targetUid)
  const userSnapshot = await userRef.get()

  if (!userSnapshot.exists) {
    throw new HttpsError("not-found", "Account not found.")
  }

  const userData = userSnapshot.data() as UserDoc
  const authUser = await adminAuth.getUser(targetUid).catch(() => null)

  // Awaited BEFORE the literal rather than inside it: two awaits inside one object literal run
  // one after the other, and these two queries are independent of each other.
  const [platformAdminCount, soleOwnedOrgIdsWithOtherMembers] = await Promise.all([
    countPlatformAdmins(),
    findSoleOwnedSharedOrgs(targetUid),
  ])

  const eligibility = evaluateAccountDeletionEligibility({
    isDeleted: Boolean(userData?.profileStatus?.isDeleted),
    isPlatformAdmin: userData?.role === "admin" || isBootstrapAdminEmail(authUser?.email),
    platformAdminCount,
    soleOwnedOrgIdsWithOtherMembers,
  })

  if (!eligibility.allowed) {
    throw new HttpsError("failed-precondition", eligibility.message)
  }

  // 1. Money, before the door is locked.
  await cancelStripeBilling(targetUid)

  // 2. Record the notice details before the Auth record is rewritten, because that
  //    rewrite is what destroys the address we need to write to.
  const originalEmail = authUser?.email || userData?.email || null

  // 3. Lock the door. `disabled` stops sign-in and new tokens; revoking refresh tokens
  //    stops the ones already issued from being renewed; the Redis tombstone closes
  //    the remaining window where an already-minted ID token would still be accepted.
  try {
    await adminAuth.updateUser(targetUid, {
      disabled: true,
      email: erasedAuthEmail(targetUid),
      emailVerified: false,
    })
  } catch (error) {
    console.error(`Failed to disable Auth account ${targetUid}:`, error)
    throw new HttpsError(
      "unavailable",
      "Could not disable the account. Nothing was deleted — please retry shortly.",
    )
  }

  await adminAuth.revokeRefreshTokens(targetUid)
  const sessionsRevoked = await revokeActiveSessions(targetUid, deletedBy)

  await markAccountDeleted(targetUid)

  // 4. State and audit.
  const now = new Date()
  const purgeAfter = resolvePurgeAfter(actor, now)

  const deletionId = await writeAdminAudit({
    action: "account_deletion_scheduled",
    actorUid: deletedBy,
    actorType: actor,
    targetUid,
    reason: reason ?? (actor === "self" ? "self_service_request" : "admin_action"),
    purgeAfter: Timestamp.fromDate(purgeAfter),
    sessionsRevoked,
    // Retained so support can identify the account and restore it inside the grace
    // window. Scrubbed at purge time — see `purgeDeletedAccounts`.
    originalEmail,
    originalUsername: userData?.username ?? null,
  })

  await userRef.set({
    profileStatus: {
      ...(userData?.profileStatus ?? {}),
      isDeleted: true,
      isBanned: false,
      banReason: null,
      banExpires: null,
      deletedAt: Timestamp.fromDate(now),
      deleteReason: reason ?? (actor === "self" ? "self_service_request" : "admin_action"),
      deletedBy,
      deletionId,
      purgeAfter: Timestamp.fromDate(purgeAfter),
      purgedAt: null,
    },
    updated_At: Timestamp.now(),
  }, {merge: true})

  await notifyAccountNotice({
    uid: targetUid,
    to: originalEmail,
    subject: "Your account is scheduled for deletion",
    content: {
      preheader: `Your account will be permanently deleted on ${purgeAfter.toISOString().slice(0, 10)}.`,
      heading: "Account scheduled for deletion",
      intro: actor === "self" ?
        "Your account has been closed and every device has been signed out. Nothing has been erased yet." :
        "An administrator has closed this account. Every device has been signed out.",
      details: [
        {label: "Account", value: targetUid},
        {label: "Closed at", value: `${now.toISOString().slice(0, 16).replace("T", " ")} UTC`},
        {label: "Permanent deletion", value: `${purgeAfter.toISOString().slice(0, 16).replace("T", " ")} UTC`},
      ],
      callout: {
        tone: "danger",
        text: "After the deletion date this account, its personal data and its sign-in record are removed permanently. Invoices and billing records are retained as required by tax law.",
      },
      cta: {label: "Contact support", url: `${env.MARKETING_ORIGIN}/contact`},
      footnote: "If this was not expected, contact support immediately — it can still be reversed before the deletion date.",
    },
    alertCategory: "account_deletion_scheduled",
    alertTitle: "Account scheduled for deletion",
    alertMessage: `Your account will be permanently deleted on ${purgeAfter.toISOString().slice(0, 10)}.`,
  })

  return {
    deletionId,
    purgeAfter: purgeAfter.toISOString(),
    sessionsRevoked,
  }
}

// ---------------------------------------------------------------------------
// Self-service callables
// ---------------------------------------------------------------------------

/**
 * Phase 1 — email a confirmation code.
 *
 * Two factors guard the destructive step, and neither is a password prompt: possession
 * of the live session, plus control of the mailbox the account was registered with.
 * The mailbox is the factor that matters, because it is the only one a hijacked
 * session cannot forge.
 */
export const requestMyAccountDeletion = onCall(CALLABLE_OPTIONS, async (request) => {
  const uid = request.auth?.uid
  if (!uid) {
    throw new HttpsError("unauthenticated", "You must be signed in.")
  }

  const {reason} = validateCallableData(
    z.object({reason: z.string().max(280).optional()}),
    request.data,
  )

  const userSnapshot = await db.collection("users").doc(uid).get()
  if (!userSnapshot.exists) {
    throw new HttpsError("not-found", "Account not found.")
  }

  const userData = userSnapshot.data() as UserDoc
  if (userData?.profileStatus?.isDeleted) {
    throw new HttpsError("failed-precondition", "This account is already scheduled for deletion.")
  }

  const authUser = await adminAuth.getUser(uid)
  const recipient = authUser.email
  if (!recipient) {
    throw new HttpsError(
      "failed-precondition",
      "This account has no email address on file. Contact support to close it.",
    )
  }

  await enforceBudget(
    accountDeletionRequestKey(uid),
    ACCOUNT_DELETION_REQUEST_MAX,
    ACCOUNT_DELETION_REQUEST_WINDOW_SECONDS,
    "Too many deletion requests. Please try again later.",
  )

  const code = String(randomInt(0, 10 ** DELETION_CONFIRMATION_CODE_LENGTH))
    .padStart(DELETION_CONFIRMATION_CODE_LENGTH, "0")
  const expiresAt = new Date(Date.now() + DELETION_CONFIRMATION_TTL_HOURS * 60 * 60 * 1000)

  await db.collection("deletion_requests").doc(uid).set({
    // Only the hash is stored. A leaked document must not yield a usable code — the
    // device-verification OTP stores its code in plaintext, and that is a ceiling worth
    // not repeating on the path that destroys an account.
    codeHash: hashDeletionCode(uid, code),
    expiresAt: Timestamp.fromDate(expiresAt),
    requestedAt: Timestamp.now(),
    reason: reason ?? null,
  })

  const delivery = await sendEmail({
    to: recipient,
    subject: "Confirm account deletion",
    html: renderEmail({
      preheader: "Enter this code to confirm closing your account.",
      heading: "Confirm account deletion",
      intro: "Use the code below to confirm that you want to close this account. It expires in 24 hours.",
      details: [
        {label: "Confirmation code", value: code},
        {label: "Expires", value: `${expiresAt.toISOString().slice(0, 16).replace("T", " ")} UTC`},
      ],
      callout: {
        tone: "warning",
        text: "If you did not request this, do not share the code with anyone. Your account is not affected until the code is confirmed.",
      },
      footnote: "Nobody at deepscrape will ever ask you for this code.",
    }),
    text: renderEmailText({
      preheader: "Enter this code to confirm closing your account.",
      heading: "Confirm account deletion",
      intro: "Use the code below to confirm that you want to close this account. It expires in 24 hours.",
      details: [
        {label: "Confirmation code", value: code},
        {label: "Expires", value: `${expiresAt.toISOString().slice(0, 16).replace("T", " ")} UTC`},
      ],
    }),
    fromName: "deepscrape Accounts",
  })

  if (!delivery.ok) {
    // Surfaced rather than swallowed: without the code the user cannot proceed, and
    // leaving them waiting for an email that will never arrive is worse than telling them.
    await db.collection("deletion_requests").doc(uid).delete()
    throw new HttpsError("unavailable", "Could not send the confirmation email. Please try again later.")
  }

  return {
    email: maskEmail(recipient),
    expiresAt: expiresAt.toISOString(),
  }
})

/**
 * Phase 2 — verify the code and lock the account. Nothing is erased yet.
 */
export const confirmMyAccountDeletion = onCall(CALLABLE_OPTIONS, async (request) => {
  const uid = request.auth?.uid
  if (!uid) {
    throw new HttpsError("unauthenticated", "You must be signed in.")
  }

  const {code, reason} = validateCallableData(
    z.object({code: z.string().min(4).max(12), reason: z.string().max(280).optional()}),
    request.data,
  )

  await enforceBudget(
    accountDeletionAttemptKey(uid),
    ACCOUNT_DELETION_ATTEMPT_MAX,
    ACCOUNT_DELETION_ATTEMPT_WINDOW_SECONDS,
    "Too many incorrect codes. Request a new one later.",
  )

  const requestRef = db.collection("deletion_requests").doc(uid)
  const requestSnapshot = await requestRef.get()

  if (!requestSnapshot.exists) {
    throw new HttpsError("failed-precondition", "No deletion request is pending. Request a new code.")
  }

  const expiresAt = requestSnapshot.get("expiresAt") as Timestamp | undefined
  if (!expiresAt || expiresAt.toMillis() <= Date.now()) {
    await requestRef.delete()
    throw new HttpsError("failed-precondition", "The confirmation code has expired. Request a new one.")
  }

  const expected = Buffer.from(String(requestSnapshot.get("codeHash") || ""), "utf8")
  const provided = Buffer.from(hashDeletionCode(uid, code), "utf8")

  // Constant-time compare, and length-gated first because timingSafeEqual throws on a
  // length mismatch. Both are hex digests, so the length is not a secret.
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    throw new HttpsError("permission-denied", "That confirmation code is not correct.")
  }

  // Single use, before the work: a code verified twice must not be able to run the
  // destructive path twice.
  await requestRef.delete()

  const result = await performAccountDeletion({
    targetUid: uid,
    actor: "self",
    deletedBy: "self",
    reason: (reason ?? String(requestSnapshot.get("reason") || "")) || undefined,
  })

  return {success: true, ...result}
})

/**
 * Abandon a pending request. Only valid before confirmation — after that the account
 * is locked out and restoration is a support action, which is deliberate.
 */
export const cancelMyAccountDeletion = onCall(CALLABLE_OPTIONS, async (request) => {
  const uid = request.auth?.uid
  if (!uid) {
    throw new HttpsError("unauthenticated", "You must be signed in.")
  }

  const requestRef = db.collection("deletion_requests").doc(uid)
  const requestSnapshot = await requestRef.get()
  if (!requestSnapshot.exists) {
    return {success: true, cancelled: false}
  }

  await requestRef.delete()
  return {success: true, cancelled: true}
})

// ---------------------------------------------------------------------------
// Admin callables
// ---------------------------------------------------------------------------

const ADMIN_CALLABLE_OPTIONS = {
  ...CALLABLE_OPTIONS,
  // Destructive admin work runs above the default callable budget's intent: the
  // limiter still caps a loop, but a real operations session is not throttled.
  memory: "512MiB" as const,
}

/**
 * Paged, searchable account list for the admin console.
 *
 * Email is included because identifying the right account is the entire job, and
 * platform staff already hold that access. Phones, IPs, addresses and device data are
 * not — the console has no use for them, and a list response is the easiest place for
 * PII to leak into logs and screenshots.
 */
export const adminListUsers = onCall(ADMIN_CALLABLE_OPTIONS, async (request) => {
  const access = await resolveCallerAccess(request)
  if (!isPlatformAdminRole(access.role)) {
    throw new HttpsError("permission-denied", "Platform administrator access required.")
  }

  const {search, pageSize, lastDocId, filter} = validateCallableData(
    z.object({
      search: z.string().max(200).nullable().optional(),
      pageSize: z.union([z.number(), z.string()])
        .transform((val) => {
          if (typeof val === "undefined") {
            return 25
          }
          if (typeof val === "string") {
            const num = Number(val)
            return isNaN(num) ? 25 : Math.floor(num)
          }
          return Math.floor(val)
        })
        .pipe(z.number().int().min(1).max(100)),
      lastDocId: z.string().max(128).nullable().optional(),
      filter: z.enum(["all", "banned", "deleted", "admins"]).default("all"),
    }),
    request.data ?? {},
  )

  const normalisedPageSize = Math.max(1, pageSize)
  const usersRef = db.collection("users")

  let query: FirebaseFirestore.Query = usersRef

  if (filter === "banned") {
    query = query.where("profileStatus.isBanned", "==", true)
  } else if (filter === "deleted") {
    query = query.where("profileStatus.isDeleted", "==", true)
  } else if (filter === "admins") {
    query = query.where("role", "==", "admin")
  }

  if (lastDocId) {
    const cursorDoc = await usersRef.doc(lastDocId).get()
    if (!cursorDoc.exists) {
      throw new HttpsError("invalid-argument", "Pagination cursor is no longer valid.")
    }
    query = query.startAfter(cursorDoc)
  }

  const snapshot = await query.limit(normalisedPageSize + 1).get()
  const hasMore = snapshot.docs.length > normalisedPageSize
  const pageDocs = snapshot.docs.slice(0, normalisedPageSize)

  const term = search?.trim().toLowerCase()

  const items = pageDocs
    .map((doc) => {
      const data = doc.data() as UserDoc
      return {
        uid: doc.id,
        email: data?.email ?? null,
        username: data?.username ?? null,
        role: data?.role ?? "user",
        plan: data?.plan ?? "free",
        status: data?.status ?? null,
        created_At: toIso(data?.created_At),
        isBanned: Boolean(data?.profileStatus?.isBanned),
        banReason: data?.profileStatus?.banReason ?? null,
        banExpires: toIso(data?.profileStatus?.banExpires),
        isDeleted: Boolean(data?.profileStatus?.isDeleted),
        deletedAt: toIso(data?.profileStatus?.deletedAt),
        purgeAfter: toIso(data?.profileStatus?.purgeAfter),
        purgedAt: toIso(data?.profileStatus?.purgedAt),
        deletedBy: data?.profileStatus?.deletedBy ?? null,
        deletionId: data?.profileStatus?.deletionId ?? null,
      }
    })
    // Search is applied on the page rather than as a `where`, because Firestore has no
    // case-insensitive substring match on email and a range scan on a different field
    // would need a composite index per filter. Ceiling: a result on a later page of the
    // current filter is not found. Acceptable while the operator filters first.
    .filter((item) => {
      if (!term) return true
      return (item.email || "").toLowerCase().includes(term) ||
        (item.username || "").toLowerCase().includes(term) ||
        item.uid.toLowerCase().includes(term)
    })

  return {
    items,
    hasMore,
    nextLastDocId: hasMore ? pageDocs[pageDocs.length - 1].id : null,
    pageSize: normalisedPageSize,
  }
})

/** One account, with the counts an operator needs to make a decision. */
export const adminGetUserOverview = onCall(ADMIN_CALLABLE_OPTIONS, async (request) => {
  const access = await resolveCallerAccess(request)
  if (!isPlatformAdminRole(access.role)) {
    throw new HttpsError("permission-denied", "Platform administrator access required.")
  }

  const {userId} = validateCallableData(
    z.object({userId: z.string().min(1).max(128)}),
    request.data,
  )

  const [userSnapshot, authUser, sessionsCount, auditSnapshot] = await Promise.all([
    db.collection("users").doc(userId).get(),
    adminAuth.getUser(userId).catch(() => null),
    db.collection("loginSessions").where("userId", "==", userId).where("active", "==", true).count().get(),
    db.collection("admin_audit").where("targetUid", "==", userId).limit(20).get(),
  ])

  if (!userSnapshot.exists) {
    throw new HttpsError("not-found", "Account not found.")
  }

  const data = userSnapshot.data() as UserDoc

  return {
    uid: userId,
    email: data?.email ?? authUser?.email ?? null,
    username: data?.username ?? null,
    role: data?.role ?? "user",
    plan: data?.plan ?? "free",
    status: data?.status ?? null,
    created_At: toIso(data?.created_At),
    // Auth state is the authoritative lockout signal; the Firestore flag can only
    // describe intent, not enforcement.
    authDisabled: authUser?.disabled ?? null,
    authLastSignIn: authUser?.metadata?.lastSignInTime ?? null,
    activeSessions: sessionsCount.data().count,
    profileStatus: data?.profileStatus ? {
      ...data.profileStatus,
      banExpires: toIso(data.profileStatus.banExpires),
      deletedAt: toIso(data.profileStatus.deletedAt),
      purgeAfter: toIso(data.profileStatus.purgeAfter),
      purgedAt: toIso(data.profileStatus.purgedAt),
    } : null,
    history: auditSnapshot.docs.map((doc) => {
      const entry = doc.data()
      return {
        id: doc.id,
        action: entry["action"] ?? null,
        actorUid: entry["actorUid"] ?? null,
        actorType: entry["actorType"] ?? null,
        reason: entry["reason"] ?? null,
        at: toIso(entry["at"]),
        purgeAfter: toIso(entry["purgeAfter"]),
        purgedAt: toIso(entry["purgedAt"]),
        sessionsRevoked: entry["sessionsRevoked"] ?? null,
      }
    }),
  }
})

/**
 * Suspend an account: reversible, time-boxed, and separate from deletion.
 *
 * Reuses the existing `profileStatus.isBanned` / `banExpires` fields, so the UI that
 * already reads them keeps working. This is the right tool for abuse; deletion is not.
 */
export const adminSuspendUser = onCall(ADMIN_CALLABLE_OPTIONS, async (request) => {
  const access = await resolveCallerAccess(request, {fresh: true})

  const {userId, reason, days} = validateCallableData(
    z.object({
      userId: z.string().min(1).max(128),
      reason: z.string().min(3).max(280),
      days: z.number().int().min(1).max(365).optional(),
    }),
    request.data,
  )

  const callerUid = request.auth?.uid as string
  assertNotSelfTargeted(callerUid, userId)
  // The policy engine is the gate, not a role comparison: `account:suspend` is granted
  // to no role at all, so only the platform-admin short-circuit inside `canPerform` can
  // satisfy it. The resolved flag is passed in — never a literal, which would make this
  // assertion decorative.
  assertAccountPermission(
    {uid: callerUid, isPlatformAdmin: isPlatformAdminRole(access.role)},
    "suspend",
    userId,
    "Platform administrator access is required to suspend an account.",
  )

  const userRef = db.collection("users").doc(userId)
  const userSnapshot = await userRef.get()
  if (!userSnapshot.exists) {
    throw new HttpsError("not-found", "Account not found.")
  }

  if (userSnapshot.get("profileStatus.isDeleted")) {
    throw new HttpsError("failed-precondition", "This account is being deleted. Cancelling the deletion is required first.")
  }

  const now = new Date()
  const banExpires = days ? new Date(now.getTime() + days * 24 * 60 * 60 * 1000) : null

  await adminAuth.updateUser(userId, {disabled: true})
  await adminAuth.revokeRefreshTokens(userId)
  const sessionsRevoked = await revokeActiveSessions(userId, callerUid)

  await userRef.set({
    profileStatus: {
      ...(userSnapshot.get("profileStatus") ?? {}),
      isBanned: true,
      banReason: reason,
      banExpires: banExpires ? Timestamp.fromDate(banExpires) : null,
    },
    updated_At: Timestamp.now(),
  }, {merge: true})

  const auditId = await writeAdminAudit({
    action: "account_suspended",
    actorUid: callerUid,
    actorRole: access.role,
    targetUid: userId,
    reason,
    banExpires: banExpires ? Timestamp.fromDate(banExpires) : null,
    sessionsRevoked,
  })

  await notifyAccountNotice({
    uid: userId,
    to: userSnapshot.get("email") || null,
    subject: "Your account has been suspended",
    content: {
      preheader: "Your deepscrape account has been suspended.",
      heading: "Account suspended",
      intro: "Access to this account has been suspended by an administrator.",
      details: [
        {label: "Reason", value: reason},
        {label: "Until", value: banExpires ? `${banExpires.toISOString().slice(0, 10)}` : "Until further notice"},
      ],
      callout: {tone: "danger", text: "You have been signed out on every device."},
      cta: {label: "Appeal", url: `${env.MARKETING_ORIGIN}/contact`},
    },
    alertCategory: "account_suspended",
    alertTitle: "Account suspended",
    alertMessage: reason,
  })

  return {success: true, auditId, sessionsRevoked, banExpires: banExpires?.toISOString() ?? null}
})

/** Lift a suspension. */
export const adminUnsuspendUser = onCall(ADMIN_CALLABLE_OPTIONS, async (request) => {
  const access = await resolveCallerAccess(request, {fresh: true})
  if (!isPlatformAdminRole(access.role)) {
    throw new HttpsError("permission-denied", "Platform administrator access required.")
  }

  const {userId, reason} = validateCallableData(
    z.object({userId: z.string().min(1).max(128), reason: z.string().max(280).optional()}),
    request.data,
  )

  const callerUid = request.auth?.uid as string
  const userRef = db.collection("users").doc(userId)
  const userSnapshot = await userRef.get()

  if (!userSnapshot.exists) {
    throw new HttpsError("not-found", "Account not found.")
  }

  // Re-enabling a deleted account would hand back a session on an account whose data
  // is scheduled for erasure. Deletion must be cancelled explicitly first.
  if (userSnapshot.get("profileStatus.isDeleted")) {
    throw new HttpsError("failed-precondition", "This account is scheduled for deletion. Cancel the deletion instead.")
  }

  // Re-enable Auth first: if this fails there is nothing to undo, and a Firestore flag
  // that says "not banned" on a still-disabled Auth account is the confusing state.
  await adminAuth.updateUser(userId, {disabled: false})

  await userRef.set({
    profileStatus: {
      ...(userSnapshot.get("profileStatus") ?? {}),
      isBanned: false,
      banReason: null,
      banExpires: null,
    },
    updated_At: Timestamp.now(),
  }, {merge: true})

  const auditId = await writeAdminAudit({
    action: "account_unsuspended",
    actorUid: callerUid,
    actorRole: access.role,
    targetUid: userId,
    reason: reason ?? "admin_action",
  })

  return {success: true, auditId}
})

/**
 * Phase 2, admin-initiated. Same routine as the self-service path, with a shorter grace
 * window and `deletedBy` naming the operator.
 */
export const adminScheduleAccountDeletion = onCall(ADMIN_CALLABLE_OPTIONS, async (request) => {
  const access = await resolveCallerAccess(request, {fresh: true})

  const {userId, reason} = validateCallableData(
    z.object({userId: z.string().min(1).max(128), reason: z.string().min(3).max(280)}),
    request.data,
  )

  const callerUid = request.auth?.uid as string
  assertNotSelfTargeted(callerUid, userId)
  assertAccountPermission(
    {uid: callerUid, isPlatformAdmin: isPlatformAdminRole(access.role)},
    "delete",
    userId,
    "Platform administrator access is required to delete an account.",
  )

  // A bootstrap admin may be the only one who can fix a broken platform state, so
  // deleting another one requires the highest tier of authority there is.
  const targetAuth = await adminAuth.getUser(userId).catch(() => null)
  if (isBootstrapAdminEmail(targetAuth?.email) && !isBootstrapAdminEmail(request.auth?.token?.email as string | undefined)) {
    throw new HttpsError(
      "permission-denied",
      "Only a bootstrap administrator can delete another bootstrap administrator.",
    )
  }

  const result = await performAccountDeletion({
    targetUid: userId,
    actor: "admin",
    deletedBy: callerUid,
    reason,
  })

  return {success: true, ...result}
})

/**
 * Restore an account inside its grace window.
 *
 * The data is untouched at this stage — only the lock and the flag are — so recovery is
 * a reversal, not a reconstruction. It deliberately stops working once the purge has
 * run: `purgedAt` is the point of no return, and pretending otherwise would offer a
 * button that silently corrupts a retained billing record.
 */
export const adminCancelAccountDeletion = onCall(ADMIN_CALLABLE_OPTIONS, async (request) => {
  const access = await resolveCallerAccess(request, {fresh: true})
  if (!isPlatformAdminRole(access.role)) {
    throw new HttpsError("permission-denied", "Platform administrator access required.")
  }

  const {userId, reason} = validateCallableData(
    z.object({userId: z.string().min(1).max(128), reason: z.string().max(280).optional()}),
    request.data,
  )

  const callerUid = request.auth?.uid as string
  const userRef = db.collection("users").doc(userId)
  const userSnapshot = await userRef.get()

  if (!userSnapshot.exists) {
    throw new HttpsError("not-found", "Account not found.")
  }

  if (!userSnapshot.get("profileStatus.isDeleted")) {
    throw new HttpsError("failed-precondition", "This account is not scheduled for deletion.")
  }

  if (userSnapshot.get("profileStatus.purgedAt")) {
    throw new HttpsError(
      "failed-precondition",
      "This account has already been erased and cannot be restored.",
    )
  }

  const originalEmail = String(userSnapshot.get("email") || "")
  const replacementEmail = originalEmail || (await adminAuth.getUser(userId).catch(() => null))?.email || null

  // The Auth record currently holds the undeliverable placeholder. Restore the real
  // address from the audit record so the account is usable again.
  const auditId = String(userSnapshot.get("profileStatus.deletionId") || "")
  let restoredEmail: string | null = null

  if (auditId) {
    const auditSnapshot = await db.collection("admin_audit").doc(auditId).get()
    const recorded = auditSnapshot.get("originalEmail")
    if (typeof recorded === "string" && recorded) restoredEmail = recorded
  }

  // Re-enable before clearing the flag: Auth is the enforcement point, so the reverse
  // order would briefly advertise an account as live while it still cannot sign in.
  await adminAuth.updateUser(userId, {
    disabled: false,
    ...(restoredEmail ? {email: restoredEmail, emailVerified: true} : {}),
  })

  await clearAccountDeletion(userId)

  await userRef.set({
    profileStatus: {
      ...(userSnapshot.get("profileStatus") ?? {}),
      isDeleted: false,
      deletedAt: null,
      deleteReason: null,
      deletedBy: null,
      deletionId: null,
      purgeAfter: null,
      purgedAt: null,
    },
    updated_At: Timestamp.now(),
  }, {merge: true})

  const restoreAuditId = await writeAdminAudit({
    action: "account_deletion_cancelled",
    actorUid: callerUid,
    actorRole: access.role,
    targetUid: userId,
    reason: reason ?? "admin_action",
    previousDeletionId: auditId || null,
    restoredEmail,
  })

  const recipient = restoredEmail || replacementEmail
  if (recipient) {
    await sendEmail({
      to: recipient,
      subject: "Your account has been restored",
      html: renderEmail({
        preheader: "The scheduled deletion of your account has been cancelled.",
        heading: "Account restored",
        intro: "The scheduled deletion of this account was cancelled by an administrator. Your account and data are intact.",
        callout: {tone: "info", text: "If you did not expect this, contact support."},
        // `/service/login`, not `/login`: ServiceRoutes mounts at `service`, and the
        // short form 404s. Verified against src/app/routes/service.route.ts.
        cta: {label: "Sign in", url: `${env.APP_ORIGIN}/service/login`},
      }),
      text: renderEmailText({
        preheader: "The scheduled deletion of your account has been cancelled.",
        heading: "Account restored",
        intro: "The scheduled deletion of this account was cancelled by an administrator. Your account and data are intact.",
      }),
      fromName: "deepscrape Accounts",
    })
  }

  return {success: true, auditId: restoreAuditId, restoredEmail: restoredEmail ? maskEmail(restoredEmail) : null}
})

// ---------------------------------------------------------------------------
// Phase 3 — the purger
// ---------------------------------------------------------------------------

/**
 * True when a purge failed only because the secret does not exist.
 *
 * `purgeSecretAndAllRevisions` calls `listSecretVersions` first, which THROWS
 * NOT_FOUND for a secret that was never created -- and the ids from
 * `accountSecrets` are returned for every account, so "absent" is the ORDINARY
 * case here rather than an anomaly. Reporting it as CRITICAL would put a
 * permanent alarm on every purge and teach an operator to ignore the one that
 * does matter.
 *
 * Three spellings, because the client reports the code differently across
 * transports: 5 is gRPC NOT_FOUND, 404 is its HTTP form, and the string form
 * appears once an error has been serialised.
 * @param {*} error The caught error.
 * @return {boolean} True when the secret simply does not exist.
 */
const isSecretNotFound = (error: unknown): boolean => {
  const code = (error as {code?: unknown})?.code
  return code === 5 || code === 404 || code === "NOT_FOUND"
}

/**
 * Recover the Secret Manager paths for an account's API keys.
 *
 * Must run before the subcollections are deleted: once `apikeys` is gone, the paths to
 * those secrets are gone with it, and a live credential with no record of its existence
 * is the worst possible outcome of a deletion.
 *
 * @param {string} uid Account being purged.
 * @return {Promise<string[]>} Secret Manager resource paths.
 */
const collectApiKeySecretPaths = async (uid: string): Promise<string[]> => {
  try {
    const snapshot = await db.collection(`users/${uid}/apikeys`).limit(100).get()
    return snapshot.docs
      .map((doc) => String(doc.get("secretPath") || ""))
      .filter((path) => path.length > 0)
  } catch (error) {
    console.warn(`Could not enumerate API keys for ${uid}:`, error)
    return []
  }
}

/**
 * Erase one account: credentials, secrets, subcollections, PII and the Auth record.
 *
 * Ordering is load-bearing at every step:
 *   - secrets before their directory entry, or the paths are lost
 *   - Auth deletion before the document rewrite, so a failure leaves the expensive,
 *     irreversible half done and the retry short-circuits on the catch
 *   - the retained collections are never enumerated for deletion; everything the
 *     account owns that is *not* on the retention list is
 *
 * @param {string} uid Account to erase.
 * @param {Timestamp} now Purge timestamp.
 * @return {Promise<object>} What was removed.
 */
/**
 * Move every live browser session's `idleDeadline` into the past so the reaper disposes of
 * its machine on the next tick.
 *
 * Suspending needs an authenticated arachnefly call carrying the owner's ID token, and a
 * scheduled purger has no caller. `idleDeadline` is the lever this repo already uses for
 * exactly that (see `expireMeteredSession`), so the purge hands the machines over instead
 * of destroying the only pointer to them. The session documents are therefore left in
 * place for the reaper to close.
 * @param {string} uid The account about to be erased.
 * @return {Promise<string[]>} Machine ids now queued for the reaper, may be empty.
 */
async function expireSessionsForReaper(uid: string): Promise<string[]> {
  const machineIds: string[] = []
  try {
    const sessions = await db.collection("users").doc(uid).collection("browserSessions").get()
    const now = Date.now()
    for (const doc of sessions.docs) {
      const data = doc.data() as {machineId?: unknown; state?: unknown}
      if (typeof data.machineId !== "string" || !data.machineId || data.state === "closed") {
        continue
      }
      // A deadline at or before `now` is due; `0` means "no expiry" to the reaper, so a
      // past epoch is the only value that works for a tier that never set one.
      await doc.ref.set({idleDeadline: now - 1}, {merge: true})
      machineIds.push(data.machineId)
    }
  } catch (error) {
    // Losing the list must not block an erasure that is past its deadline.
    console.error(`CRITICAL: could not expire browser sessions for deleted account ${uid}:`, error)
  }
  return machineIds
}

/**
 * Erase one account whose grace window has closed.
 *
 * Irreversible, so every step is ordered around what a partial run leaves behind:
 * credentials and objects are swept best-effort, the subcollections are destroyed
 * enumerated rather than denylisted, Auth goes last, and the user document is a whole
 * replacement (never a merge) so a PII field nobody listed cannot survive.
 *
 * Running machines are recorded before their last pointer is destroyed — see
 * `listLiveMachineIds` for why they cannot be stopped from here.
 * @param {string} uid The account to erase.
 * @param {Date} now Purge time, used for the audit trail.
 * @return {Promise<object>} What was deleted, for the batch summary and the audit row.
 */
async function purgeOneAccount(uid: string, now: Date): Promise<{
  uid: string
  collectionsDeleted: string[]
  secretsPurged: number
  blobsDeleted: number
  authDeleted: boolean
}> {
  const userRef = db.collection("users").doc(uid)

  const [userSnapshot, storedPaths] = await Promise.all([
    userRef.get(),
    collectApiKeySecretPaths(uid),
  ])

  const userData = userSnapshot.data() as UserDoc

  // Two sources, and BOTH are needed. `apikeys` is data-driven: a BYOK AI key has
  // no derivable id, so its `secretPath` is the only record of it and has to be
  // read before the subcollections go. The rest are derived from the uid by
  // `accountSecrets`, and that is what catches `storage-byob-<uid>` and
  // `browser-cdp-<uid>` -- recorded as a path ON a subcollection document, so the
  // sweep below removes the pointer and would otherwise leave the live credential
  // behind. See `domain/account-secrets.domain.ts`.
  const secretPaths = [
    ...storedPaths,
    ...accountSecrets(uid).map((secret) => secretPathFor(secret.id)),
  ]

  let secretsPurged = 0
  for (const secretPath of secretPaths) {
    try {
      await purgeSecretAndAllRevisions(secretPath)
      secretsPurged += 1
    } catch (error) {
      if (isSecretNotFound(error)) {
        continue
      }
      // A secret that cannot be purged is a dangling credential — worth a loud log, but
      // not a reason to abandon the erasure of everything else.
      console.error(`CRITICAL: failed to purge secret ${secretPath} for deleted account ${uid}:`, error)
    }
  }

  // Objects, swept by the DERIVED namespace prefix, so nothing here reads
  // Firestore and a lost pointer cannot hide a blob — the same property the
  // derived secret ids have. Best-effort, like the secrets above: an object
  // store outage must not block the erasure of everything else. Only the
  // PLATFORM bucket is swept; see `infrastructure/blob-purge.ts` for why a
  // caller's own bucket is left alone.
  let blobsDeleted = 0
  // Optimistic until a sweep says otherwise, so an account that stored nothing
  // still records a COMPLETED erasure.
  let blobsComplete = true
  try {
    const swept = await purgeAccountBlobs(uid)
    blobsDeleted = swept.deleted
    blobsComplete = swept.complete
  } catch (error) {
    // A THROW leaves objects behind just as surely as a truncated sweep, and it
    // used to be indistinguishable from "nothing to delete": the run carried on
    // and wrote `purgedAt`, which is precisely what stops anything retrying.
    blobsComplete = false
    console.error(`CRITICAL: failed to purge blobs for deleted account ${uid}:`, error)
  }

  // The customer id lives on the document this function rewrites, so Stripe goes first.
  // Deleting the customer is also what removes the saved cards and the name, email and
  // phone Stripe holds.
  const stripeDeleted = await deleteStripeCustomer(uid, userData?.stripeId)

  // Hand the machines over before anything that points at them disappears, and keep the
  // session documents: they are the reaper's only route to the VM.
  const orphanedMachines = await expireSessionsForReaper(uid)
  if (orphanedMachines.length > 0) {
    console.log(
      `Handed ${orphanedMachines.length} machine(s) from ${uid} to the reaper: ${orphanedMachines.join(", ")}`
    )
  }

  // Enumerate rather than denylist: any subcollection this account owns that is not
  // explicitly retained is destroyed, including ones added after this file was written.
  const collectionsDeleted: string[] = []
  try {
    const collections = await userRef.listCollections()
    for (const collectionRef of collections) {
      if (RETENTION_SUBCOLLECTIONS.includes(collectionRef.id)) continue
      // Already handed to the reaper: deleting it now would destroy the last pointer to a
      // machine that is still running.
      if (collectionRef.id === "browserSessions" && orphanedMachines.length > 0) continue
      await db.recursiveDelete(collectionRef)
      collectionsDeleted.push(collectionRef.id)
    }
  } catch (error) {
    console.error(`Failed to delete subcollections for ${uid}:`, error)
    throw error
  }

  // Top-level, uid-keyed collections are NOT subcollections of `users/{uid}`, so the
  // enumeration above cannot see them — and each holds PII the deletion notice promises
  // to shred: sign-in history, OTP attempts, presence, membership grants.
  await db.recursiveDelete(db.doc(`login_metrics/${uid}`))
  collectionsDeleted.push("login_metrics")
  await Promise.all([
    db.doc(`presence/${uid}`).delete(),
    db.doc(`deletion_requests/${uid}`).delete(),
  ])

  // shortcut: one page of 500 per collection; an account holding more needs a second run.
  // Turn this into a paged loop when a real account exceeds that.
  for (const collection of ["device_verifications", "memberships"]) {
    const page = await db.collection(collection).where("userId", "==", uid).limit(500).get()
    if (page.empty) continue

    const strayBatch = db.batch()
    page.docs.forEach((doc) => strayBatch.delete(doc.ref))
    await strayBatch.commit()
    collectionsDeleted.push(collection)

    if (page.size === 500) {
      console.error(`CRITICAL: ${uid} left rows in ${collection}; the purge deletes 500 per run.`)
    }
  }

  // The Auth record is the login itself. Absent already means a previous partial run
  // finished this step, which is success.
  let authDeleted = false
  try {
    await adminAuth.deleteUser(uid)
    authDeleted = true
  } catch (error) {
    const code = (error as { code?: string })?.code
    if (code === "auth/user-not-found") {
      authDeleted = true
    } else {
      throw error
    }
  }

  // Full replacement, never a merge: this is what guarantees a PII field nobody
  // remembered to list does not survive.
  // WHO confirmed the deletion, derived rather than assumed. This was a literal
  // "self" for every erase, so an admin-initiated one was indistinguishable from
  // a self-service one in the only record that survives. `deletedBy` holds the
  // acting uid, so when it IS the account being erased the customer acted.
  const deletedBy = String(userData?.profileStatus?.deletedBy || "")
  const actor: AccountDeletionActor =
    deletedBy && deletedBy !== uid ? "admin" : "self"

  await userRef.set(buildErasedUserRecord({
    uid,
    now,
    actor,
    deletedBy: deletedBy || "system",
    reason: userData?.profileStatus?.deleteReason,
    deletionId: String(userData?.profileStatus?.deletionId || ""),
    retained: pickRetained(userData),
  }), {merge: false})

  // A truncated or failed sweep must NOT be recorded as a finished erasure.
  // `buildErasedUserRecord` stamps `purgedAt` and CLEARS `purgeAfter`, and
  // `isPurgeDue` requires both that `purgedAt` be absent and that `purgeAfter`
  // be a past date -- so clearing only `purgedAt` would leave the account
  // neither purged nor retryable, which is worse than either. Setting
  // `purgeAfter` to now is what makes the next sweep select it again, and the
  // purge is retry-safe: an already-deleted subcollection, an absent Auth
  // record and an absent secret are each handled as success.
  if (!blobsComplete) {
    await userRef.set(
      {profileStatus: {purgedAt: null, purgeAfter: now}},
      {merge: true},
    )
  }

  // The audit record is the retained proof that the erasure happened. Its identifying
  // fields exist only to support a restore inside the grace window, so they go now that
  // the window has closed — the record keeps the fact, not the person.
  const deletionId = String(userData?.profileStatus?.deletionId || "")
  if (deletionId) {
    await db.collection("admin_audit").doc(deletionId).set({
      purgedAt: Timestamp.fromDate(now),
      collectionsDeleted,
      secretsPurged,
      blobsDeleted,
      stripeDeleted,
      // Durable, not just a log line: this is the only surviving record of machines
      // handed to the reaper instead of being released by the purge.
      machinesToRelease: orphanedMachines,
      retentionScrubbedAt: Timestamp.fromDate(now),
      originalEmail: null,
      originalUsername: null,
    }, {merge: true})
  }

  return {uid, collectionsDeleted, secretsPurged, blobsDeleted, authDeleted}
}

/**
 * Daily erasure of accounts whose grace window has closed.
 *
 * Ceiling: at most `PURGE_BATCH_SIZE` accounts per run, and `recursiveDelete` is one
 * call per subcollection. If the backlog ever exceeds the batch, the remainder waits
 * for tomorrow rather than risking a timeout that leaves an account half-erased —
 * partial erasure is safe (the next run resumes via `purgedAt`) but noisy. Move to a
 * task queue if the backlog stops draining.
 *
 * A failure on one account never stops the run: one broken account must not block the
 * erasure obligations owed to everyone behind it.
 */
export const purgeDeletedAccounts = onSchedule(
  {
    schedule: "30 3 * * *",
    timeZone: "UTC",
    // Do NOT prepend `functionsEnvJson` here. `stripeSecrets` ALREADY contains it
    // (`app/config.ts` builds it as `[stripeSecretParam, stripeWebhookSecretParam,
    // functionsEnvJson]`), so `[functionsEnvJson, ...stripeSecrets]` deployed
    // `FUNCTIONS_ENV_JSON` TWICE and Cloud Run refused the whole revision with
    // "Duplicate secret environment variable: FUNCTIONS_ENV_JSON" -- which is how
    // this function failed to CREATE on 2026-10-15.
    //
    // The Stripe secret is still bound, which is what this option is for: it is the
    // first element of that same array, and without it any billing check throws.
    secrets: stripeSecrets,
  },
  async () => {
    const now = new Date()

    // Single-field filter only — no composite index to deploy. `isDeleted` is rare and
    // bounded, so the deadline filter runs in memory.
    const snapshot = await db
      .collection("users")
      .where("profileStatus.isDeleted", "==", true)
      .limit(PURGE_BATCH_SIZE * 4)
      .get()

    const due = snapshot.docs
      .filter((doc) => isPurgeDue(doc.get("profileStatus"), now))
      .slice(0, PURGE_BATCH_SIZE)

    if (due.length === 0) {
      return
    }

    let purged = 0
    let failed = 0

    for (const doc of due) {
      try {
        const result = await purgeOneAccount(doc.id, now)
        purged += 1
        console.log(
          `Purged account ${result.uid}: deleted [${result.collectionsDeleted.join(", ")}], ` +
          `${result.secretsPurged} secrets, ${result.blobsDeleted} blobs, auth=${result.authDeleted}`,
        )
      } catch (error) {
        failed += 1
        console.error(`Failed to purge account ${doc.id}:`, error)
      }
    }

    console.log(`Account purge finished: ${purged} purged, ${failed} failed, ${due.length} due.`)
  },
)
