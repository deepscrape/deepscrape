/* eslint-disable max-len */
import {ProfileStatus} from "./global.domain"

/**
 * Account lifecycle policy: who may be deleted, when the erasure runs, and exactly
 * what survives it.
 *
 * Pure — no Firestore, no Auth, no clock. Everything here is a decision the callables
 * and the scheduled purger delegate to, so the destructive path is testable without
 * an emulator. Erasure is the one operation in this system that cannot be undone by
 * a retry, so it is the one that least deserves to be unit-test-unfriendly.
 */

/** Who pulled the trigger. Drives the grace window and the retained audit record. */
export type AccountDeletionActor = "self" | "admin"

/** Why a deletion was refused. Stable machine codes — the UI maps them to copy. */
export type AccountDeletionBlocker =
  | "already_deleted"
  | "last_platform_admin"
  | "sole_owner_of_shared_org"

export type AccountDeletionEligibility =
  | { allowed: true }
  | { allowed: false; code: AccountDeletionBlocker; message: string }

/**
 * Days between confirmation and irreversible erasure.
 *
 * Self-service gets the long window: the request may have been coerced (a phished
 * session, a borrowed laptop) and support needs room to restore it. An admin action
 * gets the short window — the account is already locked out, so the only thing the
 * extra days buy is a disgruntled-user escalation, while the erasure obligation is
 * the same.
 */
export const SELF_DELETION_GRACE_DAYS = 30
export const ADMIN_DELETION_GRACE_DAYS = 7

/** How long an emailed confirmation code stays valid. */
export const DELETION_CONFIRMATION_TTL_HOURS = 24

/** Attempts allowed before the confirm path locks out for the rest of the window. */
export const DELETION_CONFIRMATION_CODE_LENGTH = 6

/**
 * Subcollections that survive the purge.
 *
 * Erasure is not absolute. GDPR Art. 17(3)(b) — and every tax authority behind it —
 * requires financial records to outlive the customer. Invoices already issued are
 * evidence of a taxable supply; deleting them is itself a compliance failure. So the
 * purge removes everything the account *is*, and keeps everything that proves what it
 * *was billed*.
 *
 * `apikey_audit` is retained for the same class of reason: it is the record that a
 * credential existed and what it was used for, which is exactly what an abuse
 * investigation needs after the credential is gone.
 *
 * Everything not listed here is deleted. The default is destruction.
 */
export const RETENTION_SUBCOLLECTIONS: readonly string[] = ["billing", "invoices", "apikey_audit"]

export type DeletionEligibilityInput = {
  /** Current `profileStatus.isDeleted`. */
  isDeleted: boolean
  /** Whether the target holds the platform-admin claim. */
  isPlatformAdmin: boolean
  /**
   * How many accounts currently hold the platform-admin claim, including the target.
   * Callers pass at least `1` when the target is an admin.
   */
  platformAdminCount: number
  /**
   * Orgs where the target is the sole owner and at least one other member remains.
   * Erasing these would strand live teammates under an owner that no longer exists —
   * the subscription keeps billing and nobody can administer it.
   */
  soleOwnedOrgIdsWithOtherMembers: string[]
}

/**
 * Decide whether an account may enter the deletion lifecycle.
 *
 * Authorization (may *this actor* do it) is a separate question, answered by
 * `canPerform` on the `account` resource. This is only about whether deleting the
 * account is a coherent thing to do at all — the same answer whoever asked.
 *
 * @param {DeletionEligibilityInput} input Current account facts.
 * @return {AccountDeletionEligibility} Allowed, or the blocker that stopped it.
 */
export function evaluateAccountDeletionEligibility(
  input: DeletionEligibilityInput,
): AccountDeletionEligibility {
  if (input.isDeleted) {
    return {
      allowed: false,
      code: "already_deleted",
      message: "This account is already scheduled for deletion.",
    }
  }

  if (input.isPlatformAdmin && input.platformAdminCount <= 1) {
    return {
      allowed: false,
      code: "last_platform_admin",
      message: "This is the last platform administrator. Promote another admin before deleting it.",
    }
  }

  if (input.soleOwnedOrgIdsWithOtherMembers.length > 0) {
    return {
      allowed: false,
      code: "sole_owner_of_shared_org",
      message: "Transfer ownership of the organizations this account solely owns before deleting it.",
    }
  }

  return {allowed: true}
}

/**
 * The instant erasure becomes due.
 *
 * @param {AccountDeletionActor} actor Who confirmed the deletion.
 * @param {Date} now Confirmation time.
 * @return {Date} The purge deadline.
 */
export function resolvePurgeAfter(actor: AccountDeletionActor, now: Date): Date {
  const days = actor === "self" ? SELF_DELETION_GRACE_DAYS : ADMIN_DELETION_GRACE_DAYS
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000)
}

/** Firestore Timestamp, a Date, or a serialized date — all seen in this codebase. */
type DateLike = { toDate?: () => Date } | string | number | Date | null | undefined

/**
 * The subset of `profileStatus` the purger reads.
 *
 * Structural rather than `ProfileStatus` because Firestore hands these fields back as
 * `Timestamp`s, not `Date`s. Widening `ProfileStatus` to admit that would drag a
 * firebase-admin type into a domain module shared by every other reader, for the sake
 * of the one caller that can parse either shape anyway.
 */
export type PurgeStatusInput = {
  isDeleted?: boolean
  purgeAfter?: DateLike
  purgedAt?: DateLike
}

const toDate = (value: DateLike): Date | null => {
  if (!value) return null
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value
  if (typeof value === "object" && typeof value.toDate === "function") {
    const date = value.toDate()
    return Number.isNaN(date.getTime()) ? null : date
  }
  const date = new Date(value as string | number)
  return Number.isNaN(date.getTime()) ? null : date
}

/**
 * Whether the purger should erase this account now.
 *
 * `purgedAt` is the idempotency guard: a run that erased the Auth record and then
 * died before the caller could record success must not erase anything twice, and a
 * retry must not re-notify.
 *
 * @param {PurgeStatusInput | undefined} status The account's `profileStatus`.
 * @param {Date} now Current time.
 * @return {boolean} True when the account is deleted, unpurged, and past its deadline.
 */
export function isPurgeDue(status: PurgeStatusInput | undefined, now: Date): boolean {
  if (!status?.isDeleted || status.purgedAt) {
    return false
  }

  const purgeAfter = toDate(status.purgeAfter)
  if (!purgeAfter) {
    return false
  }

  return purgeAfter.getTime() <= now.getTime()
}

/**
 * The financial and audit facts that survive erasure.
 *
 * Kept as a narrow, explicit slice rather than "the whole doc minus PII". An
 * allowlist cannot under-delete: a field added to `Users` next year is retained only
 * if someone deliberately adds it here, so the failure mode is a missing invoice
 * detail (visible, reportable) rather than a leaked email (invisible, a breach).
 */
export type RetainedAccountData = {
  created_At?: unknown
  stripeId?: string
  subscriptionId?: string
  plan?: string
  planInterval?: string
  status?: string
  balance?: number
  currentUsage?: number
  itemId?: string
  profileStatus?: ProfileStatus
}

export type ErasedAccountInput = {
  uid: string
  now: Date
  actor: AccountDeletionActor
  /** `self`, or the acting admin's uid. */
  deletedBy: string
  /** Human-readable reason, retained for the audit record. */
  reason?: string
  deletionId: string
  retained: RetainedAccountData
}

/**
 * Build the post-erasure user document.
 *
 * Returned as a **whole replacement**, not a merge patch, and the caller writes it
 * with `set(..., { merge: false })`. That is the entire point: a merge patch can only
 * remove fields someone remembered to list, so any PII field added after this file was
 * written would silently survive every future deletion. A replacement record has no
 * such blind spot — what is not in the object does not exist.
 *
 * The account is already locked out and its credentials revoked by the time this runs,
 * so there is nothing left to preserve but the billing trail.
 *
 * @param {ErasedAccountInput} input Facts needed to rebuild the record.
 * @return {Record<string, unknown>} The complete replacement document.
 */
export function buildErasedUserRecord(input: ErasedAccountInput): Record<string, unknown> {
  const {uid, now, actor, deletedBy, reason, deletionId, retained} = input

  return {
    // Kept: the pseudonymous primary key all retained financial records point at.
    uid,
    // Nulled rather than removed — `Users.email` is `string | null` and readers treat
    // null as "no address on file", which is exactly the truth after erasure.
    email: null,
    username: `deleted_${uid.slice(0, 8)}`,
    providerId: "deleted",
    providerParent: "deleted",
    providerData: [],
    emailVerified: false,
    details: {},
    phoneNumber: null,
    phoneVerified: false,
    mfa_enabled: false,
    // No account to reach, and FCM tokens are deleted with the notifications
    // subcollection. Scratch the pointers so nothing retries delivery.
    lastSeen: null,
    last_login_at: null,
    loginMetricsId: null,
    notifications: {},
    settings: {},
    onboardedAt: null,

    // Never a platform admin, whatever it was before.
    role: "user",

    // Retained for tax and dispute law. See RetainedAccountData.
    created_At: retained.created_At ?? null,
    stripeId: retained.stripeId ?? null,
    subscriptionId: retained.subscriptionId ?? null,
    plan: retained.plan ?? "free",
    planInterval: retained.planInterval ?? null,
    status: "deleted",
    balance: retained.balance ?? 0,
    currentUsage: retained.currentUsage ?? 0,
    itemId: retained.itemId ?? null,

    profileStatus: {
      ...(retained.profileStatus ?? {}),
      isDeleted: true,
      isBanned: false,
      banReason: null,
      banExpires: null,
      deletedAt: retained.profileStatus?.deletedAt ?? now,
      deleteReason: reason ?? "account_deleted",
      deletedBy,
      deletionId,
      // `purgeAfter` is reset to null because the deadline has passed: keeping a
      // stale timestamp would make a second run look due if `purgedAt` were ever lost.
      purgeAfter: null,
      purgedAt: now,
      // Distinguishes a user's own request from an admin action in the retained
      // record. That distinction is the first thing anyone asks after the fact.
      deletionActor: actor,
    },

    updated_At: now,
  }
}

/**
 * Auth email for an erased account.
 *
 * Firebase requires an address, and the original must be released immediately so the
 * person can register again. `.invalid` is reserved by RFC 2606, so this address can
 * never accidentally receive mail or collide with a real signup.
 *
 * @param {string} uid The account being erased.
 * @return {string} A syntactically valid, permanently undeliverable address.
 */
export const erasedAuthEmail = (uid: string): string => `deleted+${uid}@deleted.invalid`
