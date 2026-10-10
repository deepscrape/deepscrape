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
 * A store that answers each page in turn, then an empty one.
 * @param {Array} pages The pages to hand back, in order; each is a `StoredBlob[]`.
 * @return {object} The fake store, the keys it deleted, the prefixes asked for.
 */
const storeOver = (pages: StoredBlob[][]) => {
  const deleted: string[] = []
  const prefixes: string[] = []
  let call = 0

  const store = {
    list: async (prefix: string) => {
      prefixes.push(prefix)
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
  it("sweeps the caller's OWN derived namespace, and nothing else", async () => {
    const {store, deleted, prefixes} = storeOver([pageOf(2, "a")])
    const count = await purgeAccountBlobs("uid-1", store)

    assert.equal(count, 2)
    assert.deepEqual(deleted, ["a/0", "a/1"])
    // The load-bearing assertion: the prefix is the one derived from this uid.
    assert.deepEqual(prefixes, [userObjectKeyPrefix("uid-1")])
    assert.ok(prefixes[0].startsWith("users/"))
    assert.equal(prefixes[0].includes("uid-1"), false, "prefix must not hold a raw uid")
  })

  it("uses a different namespace per caller, so one cannot reach another", async () => {
    const first = storeOver([pageOf(1, "a")])
    const second = storeOver([pageOf(1, "b")])

    await purgeAccountBlobs("uid-1", first.store)
    await purgeAccountBlobs("uid-2", second.store)

    assert.notEqual(first.prefixes[0], second.prefixes[0])
  })

  it("answers zero when no platform bucket is configured", async () => {
    // Not a failure: with no bucket of ours, nothing of ours can hold the bytes.
    assert.equal(await purgeAccountBlobs("uid-1", null), 0)
  })

  it("stops at the first short page rather than walking its budget", async () => {
    const {store, deleted, prefixes} = storeOver([
      pageOf(LIST_LIMIT, "full"),
      pageOf(3, "tail"),
    ])

    const count = await purgeAccountBlobs("uid-1", store)

    assert.equal(count, LIST_LIMIT + 3)
    assert.equal(deleted.length, LIST_LIMIT + 3)
    // Two listings: the full one, then the short one that ended the walk.
    assert.equal(prefixes.length, 2)
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
    try {
      count = await purgeAccountBlobs("uid-1", store)
    } finally {
      console.warn = originalWarn
    }

    assert.equal(count, BLOB_PURGE_MAX_PAGES * LIST_LIMIT)
    assert.equal(deleted.length, BLOB_PURGE_MAX_PAGES * LIST_LIMIT)
    assert.equal(warnings.length, 1, "hitting the ceiling must be visible")
  })
})
