/* eslint-disable max-len */
import test from "node:test"
import assert from "node:assert/strict"
import {
  ADMIN_DELETION_GRACE_DAYS,
  RETENTION_SUBCOLLECTIONS,
  SELF_DELETION_GRACE_DAYS,
  buildErasedUserRecord,
  erasedAuthEmail,
  evaluateAccountDeletionEligibility,
  isPurgeDue,
  resolvePurgeAfter,
  type DeletionEligibilityInput,
} from "./account-deletion.domain"

const eligible: DeletionEligibilityInput = {
  isDeleted: false,
  isPlatformAdmin: false,
  platformAdminCount: 3,
  soleOwnedOrgIdsWithOtherMembers: [],
}

test("allows deletion for an ordinary account", () => {
  assert.equal(evaluateAccountDeletionEligibility(eligible).allowed, true)
})

test("refuses an account that is already deleted", () => {
  const result = evaluateAccountDeletionEligibility({...eligible, isDeleted: true})
  assert.equal(result.allowed, false)
  assert.equal(result.allowed === false && result.code, "already_deleted")
})

test("refuses to erase the last platform administrator", () => {
  const result = evaluateAccountDeletionEligibility({
    ...eligible,
    isPlatformAdmin: true,
    platformAdminCount: 1,
  })
  assert.equal(result.allowed === false && result.code, "last_platform_admin")
})

test("allows a platform administrator while another one remains", () => {
  const result = evaluateAccountDeletionEligibility({
    ...eligible,
    isPlatformAdmin: true,
    platformAdminCount: 2,
  })
  assert.equal(result.allowed, true)
})

test("refuses a sole owner whose org still has members", () => {
  const result = evaluateAccountDeletionEligibility({
    ...eligible,
    soleOwnedOrgIdsWithOtherMembers: ["org_1"],
  })
  assert.equal(result.allowed, false)
  assert.equal(result.allowed === false && result.code, "sole_owner_of_shared_org")
})

test("self-service gets a longer grace window than an admin action", () => {
  const now = new Date("2026-01-01T00:00:00Z")
  const selfDays = (resolvePurgeAfter("self", now).getTime() - now.getTime()) / 86_400_000
  const adminDays = (resolvePurgeAfter("admin", now).getTime() - now.getTime()) / 86_400_000

  assert.equal(selfDays, SELF_DELETION_GRACE_DAYS)
  assert.equal(adminDays, ADMIN_DELETION_GRACE_DAYS)
  assert.ok(selfDays > adminDays)
})

test("isPurgeDue ignores accounts that are not deleted or already purged", () => {
  const now = new Date("2026-02-01T00:00:00Z")

  assert.equal(isPurgeDue(undefined, now), false)
  assert.equal(isPurgeDue({isDeleted: false, purgeAfter: new Date("2026-01-01T00:00:00Z")}, now), false)
  assert.equal(
    isPurgeDue({isDeleted: true, purgeAfter: new Date("2026-01-01T00:00:00Z"), purgedAt: now}, now),
    false,
  )
})

test("isPurgeDue waits for the deadline and accepts Firestore timestamps", () => {
  const now = new Date("2026-02-01T00:00:00Z")

  assert.equal(isPurgeDue({isDeleted: true, purgeAfter: new Date("2026-03-01T00:00:00Z")}, now), false)
  assert.equal(isPurgeDue({isDeleted: true, purgeAfter: new Date("2026-01-01T00:00:00Z")}, now), true)

  // Firestore hands back a Timestamp, not a Date, when read through the Admin SDK.
  const timestampLike = {isDeleted: true, purgeAfter: {toDate: () => new Date("2026-01-01T00:00:00Z")}}
  assert.equal(isPurgeDue(timestampLike, now), true)
})

test("a cleared purgedAt is not enough on its own to make an account due", () => {
  // Pinned because the erasure path depends on it. When a blob sweep is
  // truncated the purger clears `purgedAt` so it stops recording a finished
  // erasure -- but `buildErasedUserRecord` has already set `purgeAfter` to null,
  // and this predicate then answers false. That combination (no `purgedAt`, no
  // `purgeAfter`) is neither purged nor retryable, which is worse than either, so
  // the path also sets `purgeAfter` to now. Do not simplify it to one field.
  const now = new Date("2026-02-01T00:00:00Z")

  assert.equal(
    isPurgeDue({isDeleted: true, purgedAt: null, purgeAfter: null}, now),
    false,
  )
  assert.equal(
    isPurgeDue({isDeleted: true, purgedAt: null, purgeAfter: now}, now),
    true,
  )
})

test("erasure replaces the record so PII cannot survive as an unlisted field", () => {
  const now = new Date("2026-02-01T00:00:00Z")
  const record = buildErasedUserRecord({
    uid: "abcdef1234567890",
    now,
    actor: "self",
    deletedBy: "self",
    deletionId: "del_1",
    retained: {
      created_At: "2024-01-01T00:00:00Z",
      stripeId: "cus_123",
      subscriptionId: "sub_123",
      plan: "pro",
      balance: 42,
      profileStatus: {isBanned: true, banReason: "spam", isDeleted: true, deletedAt: now},
    },
  })

  assert.equal(record["email"], null)
  assert.equal(record["phoneNumber"], null)
  assert.equal(record["providerData"] ? (record["providerData"] as unknown[]).length : -1, 0)
  assert.equal(record["details"] && Object.keys(record["details"]).length, 0)
  assert.equal(record["username"], "deleted_abcdef12")
  assert.equal(record["role"], "user")

  // Never enumerate a field that must not exist — assert its absence from the object
  // itself, which is the guarantee a replacement write provides.
  for (const forbidden of ["displayName", "photoURL", "bio", "socialLinks", "last_username_change"]) {
    assert.equal(forbidden in record, false, `${forbidden} must not be written`)
  }

  const status = record["profileStatus"] as Record<string, unknown>
  assert.equal(status["purgedAt"], now)
  assert.equal(status["purgeAfter"], null)
  assert.equal(status["deletedBy"], "self")
  assert.equal(status["deletionId"], "del_1")
  // A ban is meaningless once the account is gone, and a stale ban must not confuse
  // the retained record.
  assert.equal(status["isBanned"], false)
})

test("erasure keeps the billing trail that tax law requires", () => {
  const now = new Date("2026-02-01T00:00:00Z")
  const record = buildErasedUserRecord({
    uid: "user1",
    now,
    actor: "admin",
    deletedBy: "admin_uid",
    deletionId: "del_2",
    retained: {stripeId: "cus_999", subscriptionId: "sub_999", plan: "enterprise", balance: 7},
  })

  assert.equal(record["stripeId"], "cus_999")
  assert.equal(record["subscriptionId"], "sub_999")
  assert.equal(record["plan"], "enterprise")
  assert.equal(record["balance"], 7)
  assert.equal(record["status"], "deleted")
})

test("retention list keeps invoices and destroys everything else by default", () => {
  assert.ok(RETENTION_SUBCOLLECTIONS.includes("billing"))
  assert.ok(RETENTION_SUBCOLLECTIONS.includes("invoices"))
  // The purge treats anything unlisted as destroyable, so a credential store or
  // session table must never appear here.
  assert.ok(!RETENTION_SUBCOLLECTIONS.includes("sessions"))
  assert.ok(!RETENTION_SUBCOLLECTIONS.includes("apikeys"))
  assert.ok(!RETENTION_SUBCOLLECTIONS.includes("notifications"))
})

test("the erased Auth email can never be delivered and never collides", () => {
  assert.equal(erasedAuthEmail("uid1"), "deleted+uid1@deleted.invalid")
  assert.ok(erasedAuthEmail("uid1").endsWith("@deleted.invalid"))
})
