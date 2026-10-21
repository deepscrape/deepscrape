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
import {aiKeySecretId} from "./user-ai-settings.domain"

describe("accountSecrets", () => {
  it("composes every id from its owning helper", () => {
    const ids = accountSecrets("u1").map((secret) => secret.id)

    assert.ok(ids.includes(byobSecretId("u1")), "storage-byob missing")
    assert.ok(ids.includes(cdpSecretId("u1")), "browser-cdp missing")
    assert.ok(ids.includes(vaultKeySecretId("u1")), "vault-key missing")
  })

  it("covers the BYOK AI credentials, not just the subcollection ones", () => {
    // The gap this closes: a vendor key lives in Secret Manager while only a
    // POINTER sits at `users/{uid}/private/ai`, so `recursiveDelete` destroyed
    // the pointer and the live credential outlived the account for ever.
    const ids = accountSecrets("u1").map((secret) => secret.id)

    assert.ok(ids.includes(aiKeySecretId("u1", "openai")), "openai key missing")
    assert.ok(ids.includes(aiKeySecretId("u1", "jina")), "jina key missing")
  })

  it("pins the count, so a silent removal fails", () => {
    // A registry that quietly loses an entry is the bug this file exists to
    // catch, and `includes` alone would not notice. Three derived credentials
    // plus one per provider id -- 10 AI vendors and 3 scrape readers.
    assert.equal(accountSecrets("u1").length, 16)
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

    // The DISTINCT set, because the AI keys are one row per vendor. The exact
    // count is pinned separately, so collapsing them here cannot hide a loss.
    assert.deepEqual(
      [...new Set(resources)],
      ["storage-byob", "browser-cdp", "vault-key", "ai-key"]
    )
  })
})
