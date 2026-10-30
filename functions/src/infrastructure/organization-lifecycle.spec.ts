/* eslint-disable max-len */
import test from "node:test"
import assert from "node:assert/strict"
import {
  addedAtMillis,
  organizationMembershipId,
} from "./organization-lifecycle"

const member = (createdAt: unknown) => ({get: () => createdAt})

test("keys a membership by the person and the org", () => {
  assert.equal(organizationMembershipId("u1", "org_a"), "u1_org_a")
})

test("reads a server timestamp", () => {
  assert.equal(addedAtMillis(member({toMillis: () => 1700000000000})), 1700000000000)
})

test("reads the Date the callables write", () => {
  assert.equal(addedAtMillis(member(new Date(1690000000000))), 1690000000000)
})

test("sorts an unreadable grant last instead of throwing", () => {
  assert.equal(addedAtMillis(member(undefined)), Number.MAX_SAFE_INTEGER)
  assert.equal(addedAtMillis(member("yesterday")), Number.MAX_SAFE_INTEGER)
})

test("picks the longest-standing member as the heir", () => {
  const roster = [
    member(new Date(3000)),
    member(new Date(1000)),
    member(undefined),
  ]

  assert.equal(roster.slice().sort((a, b) => addedAtMillis(a) - addedAtMillis(b))[0], roster[1])
})
