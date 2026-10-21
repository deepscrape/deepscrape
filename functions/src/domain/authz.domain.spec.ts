/* eslint-disable max-len */
import test from "node:test"
import assert from "node:assert/strict"
import {canPerform, AuthorizationSubject} from "./authz.domain"

const baseSubject: AuthorizationSubject = {
  uid: "u_1",
  isPlatformAdmin: false,
  memberships: {},
}

test("allows self-owned machine deploy without org membership", () => {
  const allowed = canPerform(baseSubject, "machine", "deploy", {
    ownerId: "u_1",
  })

  assert.equal(allowed, true)
})

test("denies org machine deploy for non-member", () => {
  const allowed = canPerform(baseSubject, "machine", "deploy", {
    ownerId: "u_1",
    orgId: "org_1",
  })

  assert.equal(allowed, true)

  const denied = canPerform({...baseSubject, uid: "u_2"}, "machine", "deploy", {
    ownerId: "u_1",
    orgId: "org_1",
  })

  assert.equal(denied, false)
})

test("allows org member to execute crawl in org context", () => {
  const subject: AuthorizationSubject = {
    ...baseSubject,
    memberships: {
      org_1: "member",
    },
  }

  const allowed = canPerform(subject, "crawl", "execute", {
    orgId: "org_1",
    ownerId: "u_3",
  })

  assert.equal(allowed, true)
})

test("allows platform admin bypass", () => {
  const subject: AuthorizationSubject = {
    uid: "u_admin",
    isPlatformAdmin: true,
    memberships: {},
  }

  const allowed = canPerform(subject, "organization", "manage", {
    orgId: "org_99",
    ownerId: "u_other",
  })

  assert.equal(allowed, true)
})

test("allows self to manage organization creation context", () => {
  const allowed = canPerform(baseSubject, "organization", "manage", {
    ownerId: "u_1",
  })

  assert.equal(allowed, true)
})

test("allows self to read organization in self-scoped context", () => {
  const allowed = canPerform(baseSubject, "organization", "read", {
    ownerId: "u_1",
  })

  assert.equal(allowed, true)
})

test("denies org invitation without org membership", () => {
  const denied = canPerform(baseSubject, "organization", "invite", {
    orgId: "org_1",
  })

  assert.equal(denied, false)
})

test("denies org read when scoped org has no membership and no owner fallback", () => {
  const denied = canPerform(baseSubject, "organization", "read", {
    orgId: "org_2",
  })

  assert.equal(denied, false)
})

test("denies cross-tenant machine read when membership is for a different org", () => {
  const subject: AuthorizationSubject = {
    ...baseSubject,
    memberships: {
      org_alpha: "member",
    },
  }

  const denied = canPerform(subject, "machine", "read", {
    orgId: "org_beta",
    ownerId: "u_other",
  })

  assert.equal(denied, false)
})

test("allows in-tenant machine read for member role", () => {
  const subject: AuthorizationSubject = {
    ...baseSubject,
    memberships: {
      org_alpha: "member",
    },
  }

  const allowed = canPerform(subject, "machine", "read", {
    orgId: "org_alpha",
    ownerId: "u_other",
  })

  assert.equal(allowed, true)
})

// ---------------------------------------------------------------------------
// The permission matrix, asserted as a TABLE rather than by example.
// ---------------------------------------------------------------------------

/**
 * The cases above are illustrative: each proves one grant works. NONE of them
 * fails when a grant is ADDED, so `billing.manage` reaching `member` or
 * `platform.read` reaching `owner` would leave this suite green -- and those are
 * exactly the edits a refactor of POLICIES makes by accident.
 *
 * `PAIRS` is hand-written on purpose: the actions live in a TYPE, and a type has
 * no runtime shape to enumerate. The count is pinned below, so adding a resource
 * or an action without extending this table fails loudly instead of quietly
 * widening what is untested.
 */
type Pair = {resource: string; action: string}

type TestRole = "owner" | "admin" | "member" | "viewer" | "self"

const PAIRS: readonly Pair[] = [
  {resource: "ai", action: "execute"},
  {resource: "crawl", action: "execute"},
  {resource: "crawl", action: "read"},
  {resource: "machine", action: "read"},
  {resource: "machine", action: "deploy"},
  {resource: "machine", action: "update"},
  {resource: "machine", action: "delete"},
  {resource: "billing", action: "read"},
  {resource: "billing", action: "manage"},
  {resource: "organization", action: "read"},
  {resource: "organization", action: "manage"},
  {resource: "organization", action: "invite"},
  {resource: "account", action: "read"},
  {resource: "account", action: "suspend"},
  {resource: "account", action: "delete"},
  {resource: "platform", action: "read"},
  {resource: "platform", action: "write"},
  {resource: "storage", action: "read"},
  {resource: "storage", action: "write"},
]

const id = (pair: Pair): string => `${pair.resource}:${pair.action}`

/** The policy restated as data: a change to POLICIES must be made here too. */
const GRANTED: Record<TestRole, readonly string[]> = {
  owner: [
    "ai:execute",
    "crawl:execute",
    "crawl:read",
    "machine:read",
    "machine:deploy",
    "machine:update",
    "machine:delete",
    "billing:read",
    "billing:manage",
    "organization:read",
    "organization:manage",
    "organization:invite",
  ],
  admin: [
    "ai:execute",
    "crawl:execute",
    "crawl:read",
    "machine:read",
    "machine:deploy",
    "machine:update",
    "machine:delete",
    "billing:read",
    "billing:manage",
    "organization:read",
    // NO organization:manage. That single absence is what separates admin from
    // owner, and it is invisible to every by-example case above.
    "organization:invite",
  ],
  member: [
    "ai:execute",
    "crawl:execute",
    "crawl:read",
    "machine:read",
    "machine:deploy",
    "machine:update",
    // NO machine:delete, NO billing:manage, NO organization:invite.
    "billing:read",
    "organization:read",
  ],
  viewer: [
    "crawl:read",
    "machine:read",
    "billing:read",
    "organization:read",
  ],
  self: [
    "ai:execute",
    "crawl:execute",
    "crawl:read",
    "machine:read",
    "machine:deploy",
    "machine:update",
    "machine:delete",
    "billing:read",
    "billing:manage",
    "organization:read",
    "organization:manage",
    // NO organization:invite in a personal context.
    // `account:suspend` is in NO role: only the platform-admin short-circuit
    // reaches it, which is the intent recorded on the resource.
    "account:read",
    "account:delete",
    // Storage is SELF-ONLY: no org role holds either action, and that absence is
    // the isolation between two members of the same organization.
    "storage:read",
    "storage:write",
  ],
}

const ORG = "org_matrix"
const OWNER_ELSEWHERE = "u_somebody_else"

const orgSubject = (
  role: Exclude<TestRole, "self">,
): AuthorizationSubject => ({
  uid: "u_caller",
  isPlatformAdmin: false,
  memberships: {[ORG]: role},
})

const selfSubject: AuthorizationSubject = {
  uid: "u_caller",
  isPlatformAdmin: false,
  memberships: {},
}

// The org-scoped data deliberately names somebody ELSE as owner, so `self` does
// not ALSO resolve: a subject holding both roles would let a self grant satisfy
// an org-role assertion and hide a missing one.
const ORG_SCOPE = {orgId: ORG, ownerId: OWNER_ELSEWHERE}
const SELF_SCOPE = {ownerId: "u_caller"}

/**
 * The table walks (resource, action) pairs a TYPE owns, so the call cannot be
 * typed generically without existential types. The cast is confined to this one
 * line; every explicit assertion below uses the real signature.
 * @param {AuthorizationSubject} subject The caller.
 * @param {Pair} pair The resource and action to ask about.
 * @param {object} data The scope, which also decides whether `self` resolves.
 * @return {boolean} Whether the matrix grants it.
 */
const allows = (
  subject: AuthorizationSubject,
  pair: Pair,
  data: {orgId?: string; ownerId?: string},
): boolean =>
  (canPerform as unknown as (
    subject: AuthorizationSubject,
    resource: string,
    action: string,
    data: {orgId?: string; ownerId?: string},
  ) => boolean)(subject, pair.resource, pair.action, data)

test("grants exactly the matrix for every role and action", () => {
  assert.equal(
    PAIRS.length,
    19,
    "a resource or action was added without extending this table",
  )

  for (const role of Object.keys(GRANTED) as TestRole[]) {
    const subject = role === "self" ? selfSubject : orgSubject(role)
    const data = role === "self" ? SELF_SCOPE : ORG_SCOPE

    for (const pair of PAIRS) {
      assert.equal(
        allows(subject, pair, data),
        GRANTED[role].includes(id(pair)),
        `${role} -> ${id(pair)}`,
      )
    }
  }
})

test("names the grants a refactor is most likely to widen", () => {
  // The audit's four: each was a plausible-looking edit that the by-example
  // cases above cannot see.
  assert.equal(
    canPerform(orgSubject("member"), "billing", "manage", ORG_SCOPE),
    false,
    "member must not manage billing",
  )
  assert.equal(
    canPerform(orgSubject("owner"), "platform", "read", ORG_SCOPE),
    false,
    "no org role holds platform",
  )
  assert.equal(
    canPerform(orgSubject("owner"), "account", "delete", ORG_SCOPE),
    false,
    "an org admin cannot erase the account",
  )
  assert.equal(
    canPerform(selfSubject, "storage", "read", SELF_SCOPE),
    true,
    "self owns its own artifacts",
  )
})

test("an org role never inherits the caller's self grants", () => {
  // The isolation, stated once: the same uid holding an org membership is NOT
  // `self` when the resource belongs to somebody else, so storage stays shut.
  const owner: AuthorizationSubject = {
    uid: "u_caller",
    isPlatformAdmin: false,
    memberships: {[ORG]: "owner"},
  }

  assert.equal(
    canPerform(owner, "storage", "read", {orgId: ORG, ownerId: OWNER_ELSEWHERE}),
    false,
  )
  // Owned by the caller, BOTH roles resolve and the union applies.
  assert.equal(
    canPerform(owner, "storage", "read", {orgId: ORG, ownerId: "u_caller"}),
    true,
  )
})

test("the platform-admin short-circuit reaches every pair", () => {
  // `account:suspend` and both `platform` actions are granted to NO role, so the
  // short-circuit is their only route -- and it must still be a total bypass.
  const admin: AuthorizationSubject = {
    uid: "u_admin",
    isPlatformAdmin: true,
    memberships: {},
  }

  for (const pair of PAIRS) {
    assert.equal(allows(admin, pair, ORG_SCOPE), true, id(pair))
  }
})
