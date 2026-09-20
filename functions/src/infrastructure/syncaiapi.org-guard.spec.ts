/* eslint-disable max-len */
import assert from "node:assert/strict"
import test from "node:test"
import {ReverseAPIProxy} from "./syncaiapi"

// Backstop guard for the org handlers in syncaiapi.ts.
//
// Context: those handlers read Firestore with the ADMIN SDK, which bypasses
// firestore.rules entirely, so `requirePermission` is the only real gate. This guard
// exists so a route registered WITHOUT the middleware fails closed rather than
// handing over the roster / renaming another tenant's org.
//
// isOrgAuthorized is a TS `private` class field, erased at runtime — reaching it
// through a cast avoids promoting it to public API just to test it.
const guard = (locals: Record<string, unknown>, orgId: string): boolean => {
  const proxy = new ReverseAPIProxy() as unknown as {
    isOrgAuthorized: (res: unknown, orgId: string) => boolean
  }

  return proxy.isOrgAuthorized({locals}, orgId)
}

test("isOrgAuthorized denies when the middleware never ran", () => {
  // The whole point: no requirePermission => no subject => deny, not allow.
  assert.equal(guard({}, "org_1"), false)
})

test("isOrgAuthorized denies an org the caller is not a member of", () => {
  const locals = {authzSubject: {isPlatformAdmin: false, memberships: {org_mine: "owner"}}}
  assert.equal(guard(locals, "org_victim"), false)
})

test("isOrgAuthorized allows the caller's own org and platform admins", () => {
  const member = {authzSubject: {isPlatformAdmin: false, memberships: {org_mine: "viewer"}}}
  assert.equal(guard(member, "org_mine"), true)

  const admin = {authzSubject: {isPlatformAdmin: true, memberships: {}}}
  assert.equal(guard(admin, "org_any"), true)
})

test("isOrgAuthorized is not satisfied by Object.prototype keys", () => {
  // A truthy lookup would read memberships["constructor"] as a membership and
  // grant access to an org literally named "constructor".
  const locals = {authzSubject: {isPlatformAdmin: false, memberships: {}}}
  assert.equal(guard(locals, "constructor"), false)
  assert.equal(guard(locals, "toString"), false)
})
