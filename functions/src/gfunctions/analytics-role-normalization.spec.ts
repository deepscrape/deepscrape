/* eslint-disable max-len */
import assert from "node:assert/strict"
import test from "node:test"
import {normalizeGeoLookupRoles} from "./analytics"

test("normalizeGeoLookupRoles deduplicates and lowercases mixed role inputs", () => {
  const roles = normalizeGeoLookupRoles(
    "Admin, Member",
    ["viewer", "admin"],
    "OWNER",
    null,
    undefined,
    ""
  )

  assert.deepEqual(roles, ["admin", "member", "viewer", "owner"])
})

test("normalizeGeoLookupRoles splits comma-delimited strings and preserves unique ordering", () => {
  const roles = normalizeGeoLookupRoles(" self , admin ,viewer ", ["member,viewer"])

  assert.deepEqual(roles, ["self", "admin", "viewer", "member"])
})
