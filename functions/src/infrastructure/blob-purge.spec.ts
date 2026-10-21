/* eslint-disable max-len */
/* eslint-disable object-curly-spacing */
/**
 * The blob sweep.
 *
 * The assertion that matters most is the PREFIX one. A sweep that listed a
 * prefix derived from anything other than the caller's own uid -- a shared
 * prefix, or a raw uid that could straddle a namespace -- would delete another
 * tenant's objects, which is worse than the orphaned bytes it set out to fix.
 * That is why the prefix is checked here rather than assumed from the loop.
 *
 * Class-level, over an injected fake: `getPlatformBlobStore` reads the
 * environment, so a test that reached for it would need credentials.
 */
import {describe, it} from "node:test"
import assert from "node:assert/strict"
import {
  BLOB_PURGE_MAX_PAGES,
  purgeAccountBlobs,
} from "./blob-purge"
import {LIST_LIMIT, userObjectKeyPrefix} from "../domain/storage-scope.domain"
import type {BlobStore, StoredBlob} from "./blob-store.port"
import {vaultKeyPrefix} from "../domain/vault-entry.domain"

/**
 * One page of fake objects, keyed so a wrong prefix is visible.
 * @param {number} size How many objects the page carries.
 * @param {string} tag A per-page key prefix, so an assertion names the page.
 * @return {StoredBlob[]} The page.
 */
const pageOf = (size: number, tag: string): StoredBlob[] =>
  Array.from({length: size}, (_unused, index) => ({
    key: `${tag}/${index}`,
    bytes: 1,
    custom: {},
  }))

/**
 * A store that answers two namespaces: the artifact one from `pages`, the vault
 * one from `vaultPages`.
 *
 * Split by namespace because a purge walks BOTH, and one shared queue would let
 * either namespace's pages satisfy the other's assertions -- which is the
 * confusion this file exists to catch rather than to have.
 * @param {Array} pages Artifact-namespace pages, in order.
 * @param {Array} vaultPages Vault-namespace pages, in order. Empty by default.
 * @return {object} The fake store, the keys it deleted, the prefixes asked for.
 */
const storeOver = (pages: StoredBlob[][], vaultPages: StoredBlob[][] = []) => {
  const deleted: string[] = []
  const prefixes: string[] = []
  let call = 0
  let vaultCall = 0

  const store = {
    list: async (prefix: string) => {
      prefixes.push(prefix)
      if (prefix.startsWith("vault/")) {
        const vaultPage = vaultPages[vaultCall] ?? []
        vaultCall += 1
        return vaultPage
      }
      const page = pages[call] ?? []
      call += 1
      return page
    },
    delete: async (key: string) => {
      deleted.push(key)
    },
  } as unknown as BlobStore

  return {store, deleted, prefixes}
}

describe("purgeAccountBlobs", () => {
  it("sweeps both of the caller's namespaces, and nothing else", async () => {
    const {store, deleted, prefixes} = storeOver([pageOf(2, "a")])
    const {deleted: count, complete} = await purgeAccountBlobs("uid-1", store)

    assert.equal(count, 2)
    assert.equal(complete, true, "a short page means the sweep finished")
    assert.deepEqual(deleted, ["a/0", "a/1"])
    // The load-bearing assertion: both prefixes are derived from this uid, so
    // neither can reach another account's objects.
    assert.deepEqual(prefixes, [
      userObjectKeyPrefix("uid-1"),
      vaultKeyPrefix("uid-1"),
    ])
    assert.ok(prefixes[0].startsWith("users/"))
    assert.equal(prefixes[0].includes("uid-1"), false, "prefix must not hold a raw uid")
  })

  it("deletes the vault payload that no artifact prefix reaches", async () => {
    // Why the second namespace exists: a vault key is `vault/<uid>/...`, a
    // SIBLING of the artifact prefix, so a one-namespace sweep left a credential
    // behind. This is the case that fails if the second walk is removed.
    const {store, deleted} = storeOver(
      [pageOf(1, "art")],
      [pageOf(2, "vault/uid-1/github")],
    )

    const {deleted: count} = await purgeAccountBlobs("uid-1", store)

    assert.equal(count, 3)
    assert.ok(deleted.includes("vault/uid-1/github/0"))
    assert.ok(deleted.includes("vault/uid-1/github/1"))
  })

  it("uses a different namespace per caller, so one cannot reach another", async () => {
    const first = storeOver([pageOf(1, "a")])
    const second = storeOver([pageOf(1, "b")])

    await purgeAccountBlobs("uid-1", first.store)
    await purgeAccountBlobs("uid-2", second.store)

    // Both namespaces, and both differ per caller: a sweep that shared a prefix
    // between accounts would delete a stranger's objects.
    assert.notEqual(first.prefixes[0], second.prefixes[0])
    assert.notEqual(first.prefixes[1], second.prefixes[1])
    assert.equal(first.prefixes[1], vaultKeyPrefix("uid-1"))
  })

  it("stops at the first short page rather than walking its budget", async () => {
    const {store, deleted, prefixes} = storeOver([
      pageOf(LIST_LIMIT, "full"),
      pageOf(3, "tail"),
    ])

    const {deleted: count, complete} = await purgeAccountBlobs("uid-1", store)

    assert.equal(count, LIST_LIMIT + 3)
    assert.equal(complete, true)
    assert.equal(deleted.length, LIST_LIMIT + 3)
    // Three listings: the full artifact page, the short one that ended that
    // walk, then the vault namespace's single empty answer.
    assert.equal(prefixes.length, 3)
  })

  it("stops at its page ceiling instead of looping forever", async () => {
    // A store that never reports a short page -- the shape a silently failing
    // delete would produce. The ceiling is what keeps that from becoming an
    // unbounded run inside a scheduled function.
    const {store, deleted} = storeOver(
      Array.from({length: BLOB_PURGE_MAX_PAGES + 5}, () => pageOf(LIST_LIMIT, "x")),
    )

    const warnings: unknown[][] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => warnings.push(args)
    let count = 0
    let complete = true
    try {
      const swept = await purgeAccountBlobs("uid-1", store)
      count = swept.deleted
      complete = swept.complete
    } finally {
      console.warn = originalWarn
    }

    assert.equal(count, BLOB_PURGE_MAX_PAGES * LIST_LIMIT)
    assert.equal(deleted.length, BLOB_PURGE_MAX_PAGES * LIST_LIMIT)
    assert.equal(warnings.length, 1, "hitting the ceiling must be visible")
    // The whole point of the return type: a truncated sweep must say so, because
    // the caller records `purgedAt` on a count it trusts and nothing would ever
    // sweep the remainder afterwards.
    assert.equal(complete, false, "a truncated sweep is NOT a finished erasure")
  })
})
