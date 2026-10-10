/* eslint-disable object-curly-spacing */
/**
 * The vault's naming contract.
 *
 * The assertions that matter are the REFUSALS. `service` and `profile` are
 * joined onto a path on a worker -- `profiles_dir()/<service>/<profile>`
 * -- so a
 * name that escapes is a traversal, and a name the id and key builders disagree
 * about is index drift.
 */
import {describe, it} from "node:test"
import assert from "node:assert/strict"
import {
  isSafeVaultName,
  toPublicVaultEntry,
  vaultBlobKey,
  vaultEntryId,
  vaultKeySecretId,
} from "./vault-entry.domain"

describe("isSafeVaultName", () => {
  it("accepts the names real entries use", () => {
    for (const name of ["github", "work", "my-service", "v1.2", "a_b", "X9"]) {
      assert.equal(isSafeVaultName(name), true, name)
    }
  })

  it("refuses every shape that would climb out of the profile dir", () => {
    // Each of these reaches `profiles_dir().join(service).join(profile)`, and
    // Firestore would happily store most of them.
    for (const name of [
      "..",
      ".",
      "../etc",
      "a/b",
      "a\\b",
      "-flag",
      ".hidden",
      "",
    ]) {
      assert.equal(isSafeVaultName(name), false, name)
    }
  })

  it("bounds the length, because a segment is a filesystem name", () => {
    assert.equal(isSafeVaultName("a".repeat(64)), true)
    assert.equal(isSafeVaultName("a".repeat(65)), false)
  })

  it("refuses anything that is not a string", () => {
    assert.equal(isSafeVaultName(42), false)
    assert.equal(isSafeVaultName(null), false)
    assert.equal(isSafeVaultName(undefined), false)
  })
})

describe("vaultEntryId", () => {
  it("cannot be ambiguous across the two halves", () => {
    // `:` is in neither name's alphabet, which is the whole reason it is the
    // separator: an underscore would let these two collide.
    assert.notEqual(vaultEntryId("a_b", "c"), vaultEntryId("a", "b_c"))
  })

  it("is stable for the same pair", () => {
    assert.equal(vaultEntryId("github", "work"), "github:work")
  })
})

describe("vaultBlobKey", () => {
  it("namespaces under vault/ and carries the whole identity", () => {
    assert.equal(
      vaultBlobKey("u1", "github", "work"),
      "vault/u1/github/work.json",
    )
  })

  it("separates two callers holding the same entry", () => {
    // The key must never be a function of the entry alone, or one caller's blob
    // would be another's.
    assert.notEqual(
      vaultBlobKey("u1", "github", "work"),
      vaultBlobKey("u2", "github", "work"),
    )
  })
})

describe("vaultKeySecretId", () => {
  it("is per caller, not per entry", () => {
    // The key decrypts every entry, so an id that varied by entry would mean
    // deleting one entry could destroy the key for all the others.
    assert.equal(vaultKeySecretId("u1"), vaultKeySecretId("u1"))
    assert.notEqual(vaultKeySecretId("u1"), vaultKeySecretId("u2"))
  })
})

describe("toPublicVaultEntry", () => {
  it("carries the names, and nothing else when there is nothing else", () => {
    assert.deepEqual(
      toPublicVaultEntry({service: "github", profile: "work"}),
      {service: "github", profile: "work"},
    )
  })

  it("drops the bookkeeping fields", () => {
    const projected = toPublicVaultEntry({
      service: "github",
      profile: "work",
      username: "me",
      updatedAtMs: 123,
    })
    const asRecord = projected as unknown as Record<string, unknown>
    assert.equal(projected.username, "me")
    assert.equal("updatedAtMs" in asRecord, false)
  })
})
