/* eslint-disable max-len */
/* eslint-disable object-curly-spacing */
/**
 * The purge's secret registry.
 *
 * The property under test is not "these three strings" -- it is that each id
 * comes FROM ITS OWNING HELPER. A hand-rebuilt `storage-byob-` string here would
 * pass a literal assertion and still drift the day the writer's id changes, and
 * the failure mode of that drift is a live credential left behind by a deletion
 * that reported success.
 */
import {describe, it} from "node:test"
import assert from "node:assert/strict"
import {accountSecrets} from "./account-secrets.domain"
import {byobSecretId} from "./storage-settings.domain"
import {cdpSecretId} from "./browser-session.domain"
import {vaultKeySecretId} from "./vault-entry.domain"

describe("accountSecrets", () => {
  it("composes every id from its owning helper", () => {
    const ids = accountSecrets("u1").map((secret) => secret.id)

    assert.ok(ids.includes(byobSecretId("u1")), "storage-byob missing")
    assert.ok(ids.includes(cdpSecretId("u1")), "browser-cdp missing")
    assert.ok(ids.includes(vaultKeySecretId("u1")), "vault-key missing")
  })

  it("pins the count, so a silent removal fails", () => {
    // A registry that quietly loses an entry is the bug this file exists to
    // catch, and `includes` alone would not notice.
    assert.equal(accountSecrets("u1").length, 3)
  })

  it("scopes every id to the uid, and never to another account's", () => {
    const mine = accountSecrets("u1").map((secret) => secret.id)
    for (const id of mine) {
      assert.ok(id.includes("u1"), id)
    }

    const theirs = accountSecrets("u2").map((secret) => secret.id)
    for (const id of theirs) {
      assert.equal(mine.includes(id), false, id)
    }
  })

  it("names each resource, so a purge log says which credential it was", () => {
    const resources = accountSecrets("u1").map((secret) => secret.resource)
    assert.deepEqual(resources, ["storage-byob", "browser-cdp", "vault-key"])
  })
})
