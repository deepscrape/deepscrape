/* eslint-disable max-len */
import assert from "node:assert/strict"
import test from "node:test"
import {parseCachedMemberships, requirePermission} from "./authz.middleware"
import {AuthorizationSubject} from "../domain/authz.domain"

test("parseCachedMemberships rebuilds the map with a null prototype", () => {
  const parsed = parseCachedMemberships(JSON.stringify({org_a: "owner"}))

  assert.ok(parsed)
  assert.equal(parsed.org_a, "owner")

  // The property the middleware depends on: an org id the caller controls must not
  // resolve to an Object.prototype member, which is how a plain object let
  // `orgId: "constructor"` satisfy a permission check.
  assert.equal((parsed as Record<string, unknown>).constructor, undefined)
  assert.equal((parsed as Record<string, unknown>).toString, undefined)
})

test("parseCachedMemberships treats junk as a miss, never as a grant", () => {
  assert.equal(parseCachedMemberships(null), null)
  assert.equal(parseCachedMemberships(undefined), null)
  assert.equal(parseCachedMemberships(""), null)
  assert.equal(parseCachedMemberships("{not json"), null)
  assert.equal(parseCachedMemberships("\"just-a-string\""), null)

  // An array parses as an object but carries no roles.
  const fromArray = parseCachedMemberships("[1,2]")
  assert.deepEqual(fromArray ? Object.keys(fromArray) : null, [])
})

type MockResponse = {
  locals: Record<string, unknown>
  statusCode?: number
  body?: unknown
  status: (code: number) => MockResponse
  json: (payload: unknown) => void
}

/**
 * createMockResponse
 * @return {*}
 */
function createMockResponse(): MockResponse {
  return {
    locals: {},
    statusCode: undefined,
    body: undefined,
    /**
     * status
     * @param {*} code
     * @return {*}
     */
    status(code: number) {
      this.statusCode = code
      return this
    },
    /**
     * json
     * @param {*} payload
     */
    json(payload: unknown) {
      this.body = payload
    },
  }
}

test("requirePermission returns 401 when request has no authenticated user", async () => {
  const middleware = requirePermission("organization", "read")

  const req = {
    headers: {},
    params: {},
    body: {},
    query: {},
  } as never

  const res = createMockResponse() as never
  let nextCalled = false

  await middleware(req, res, () => {
    nextCalled = true
  })

  assert.equal(nextCalled, false)
  assert.equal((res as unknown as MockResponse).statusCode, 401)
})

test("requirePermission returns 403 for denied org read context", async () => {
  const middleware = requirePermission("organization", "read")

  const subject: AuthorizationSubject = {
    uid: "u_denied",
    isPlatformAdmin: false,
    memberships: {},
  }

  const req = {
    user: {uid: "u_denied"},
    headers: {},
    params: {orgId: "org_forbidden"},
    body: {},
    query: {},
  } as never

  const res = createMockResponse()
  res.locals.authzSubject = subject

  let nextCalled = false

  await middleware(req, res as never, () => {
    nextCalled = true
  })

  assert.equal(nextCalled, false)
  assert.equal(res.statusCode, 403)
})

test("requirePermission calls next for allowed org read context", async () => {
  const middleware = requirePermission("organization", "read")

  const subject: AuthorizationSubject = {
    uid: "u_allowed",
    isPlatformAdmin: false,
    memberships: {org_allowed: "owner"},
  }

  const req = {
    user: {uid: "u_allowed"},
    headers: {},
    params: {orgId: "org_allowed"},
    body: {},
    query: {},
  } as never

  const res = createMockResponse()
  res.locals.authzSubject = subject

  let nextCalled = false

  await middleware(req, res as never, () => {
    nextCalled = true
  })

  assert.equal(nextCalled, true)
  assert.equal(res.statusCode, undefined)
})

test("requirePermission ignores a client-supplied ownerId on an org route", async () => {
  // Regression guard for the cross-tenant IDOR. getOwnerIdFromRequest used to
  // read ownerId from params/body/query and apply it EVEN when an orgId was
  // present, so `?ownerId=<own-uid>` granted the "self" role alongside the
  // failing org check — and canPerform's roles.some() let that satisfy
  // organization:read (roster read) and organization:manage (org rename).
  // Ownership must be server-derived; a request-supplied ownerId must not
  // unlock an org the caller has no membership in.
  const middleware = requirePermission("organization", "read")

  const subject: AuthorizationSubject = {
    uid: "u_attacker",
    isPlatformAdmin: false,
    memberships: {}, // deliberately not a member of org_victim
  }

  const req = {
    user: {uid: "u_attacker"},
    headers: {},
    params: {orgId: "org_victim"},
    body: {},
    query: {ownerId: "u_attacker"},
  } as never

  const res = createMockResponse()
  res.locals.authzSubject = subject

  let nextCalled = false

  await middleware(req, res as never, () => {
    nextCalled = true
  })

  assert.equal(nextCalled, false)
  assert.equal(res.statusCode, 403)
})
