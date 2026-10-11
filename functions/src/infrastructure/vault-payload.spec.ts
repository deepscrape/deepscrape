/* eslint-disable max-len */
/**
 * The sealed payload store's wiring: key derivation, the port, and the object
 * key they meet at.
 *
 * The crypto module has its own spec and the route parser has another, which
 * leaves exactly one seam untested between them -- the module that reads the
 * environment, derives the key, seals, and hands bytes to the PORT. A mistake
 * here ships a credential in the clear while both of those specs stay green, so
 * the first assertion below is that what reaches the store is not the plaintext.
 *
 * No bucket and no key are needed: `env.VAULT_DATA_KEY` is set for the run and
 * the store is injected, which is the same shape `blob-purge` uses for the same
 * reason.
 */
import {after, before, describe, it} from "node:test"
import assert from "node:assert/strict"
import {env} from "../config/env"
import {vaultBlobKey, vaultKeyPrefix} from "../domain/vault-entry.domain"
import type {BlobStore, PutOptions, StoredBlob} from "./blob-store.port"
import {
  dropVaultPayload,
  getVaultPayload,
  putVaultPayload,
  vaultStorageAvailable,
} from "./vault-payload"

// Synthetic and obviously so: 32 bytes of one value.
const MASTER = Buffer.alloc(32, 5).toString("base64")

/** The environment, as the mutable object it is at runtime.
 * @return {Record<string, string>} `env`, writable.
 */
const writableEnv = (): Record<string, string> =>
  env as unknown as Record<string, string>

/** Set the sealing key for a case.
 * @param {string} value The base64 key, or "" to unset it.
 * @return {void} Nothing.
 */
const setKey = (value: string): void => {
  writableEnv()["VAULT_DATA_KEY"] = value
}

const originalKey = writableEnv()["VAULT_DATA_KEY"] ?? ""

/**
 * An in-memory port: one map, and the metadata of the last write.
 * @return {object} The store, its objects, and what `put` was told.
 */
const memoryStore = () => {
  const objects = new Map<string, Buffer>()
  const options: PutOptions[] = []

  const store = {
    put: async (key: string, body: Buffer, putOptions?: PutOptions) => {
      objects.set(key, body)
      options.push(putOptions ?? {})
    },
    get: async (key: string) => objects.get(key) ?? null,
    stat: async (key: string): Promise<StoredBlob | null> =>
      objects.has(key) ? {key, bytes: 0, custom: {}} : null,
    list: async (): Promise<StoredBlob[]> => [],
    delete: async (key: string) => {
      objects.delete(key)
    },
    signedUrl: async () => "https://example.invalid",
  } as unknown as BlobStore

  return {store, objects, options}
}

/**
 * vault payload store
 */
describe("the vault payload store", () => {
  before(() => setKey(MASTER))
  after(() => setKey(originalKey))

  /**
   * writes ciphertext, not the payload
   */
  it("writes ciphertext, not the payload", async () => {
    const {store, objects, options} = memoryStore()
    const payload = {cookies: [{name: "sid", value: "live-session"}]}

    const bytes = await putVaultPayload("u1", "github", "work", payload, store)

    const stored = objects.get(vaultBlobKey("u1", "github", "work"))
    assert.ok(stored, "the payload must land at the DERIVED key")
    assert.equal(bytes, stored.length)
    // The assertion this file exists for.
    assert.equal(
      stored.toString("utf8").includes("live-session"),
      false,
      "the plaintext must not reach the bucket",
    )
    assert.equal(options[0]?.cacheSeconds, 0, "a credential is never cached")
  })

  /**
   * round-trips through the port
   */
  it("round-trips through the port", async () => {
    const {store} = memoryStore()
    const payload = {cookies: [{name: "sid", value: "live-session"}]}

    await putVaultPayload("u1", "github", "work", payload, store)

    assert.deepEqual(
      await getVaultPayload("u1", "github", "work", store),
      payload,
    )
  })

  /**
   * answers undefined for an entry with no object
   */
  it("answers undefined for an entry with no object", async () => {
    // A miss is NOT a throw: the route turns it into a 404, and a throw here
    // would make every unsaved profile look like a broken deployment.
    assert.equal(
      await getVaultPayload("u1", "github", "nope", memoryStore().store),
      undefined,
    )
  })

  /**
   * refuses another account's entry, and a tampered object
   */
  it("refuses another account's entry, and a tampered object", async () => {
    const {store, objects} = memoryStore()
    await putVaultPayload("u1", "github", "work", {jar: "x"}, store)

    const mine = vaultBlobKey("u1", "github", "work")
    const theirs = vaultBlobKey("u2", "github", "work")

    // Copying the object to the other account's key is the case that matters:
    // the object KEY isolates the two accounts on its own, so without this the
    // assertion would only be testing the key. What stops the read here is the
    // DERIVED key, which is why the uid is in the key as well.
    objects.set(theirs, objects.get(mine) as Buffer)
    await assert.rejects(
      () => getVaultPayload("u2", "github", "work", store),
      "another account's derived key must not open this payload",
    )

    const bytes = Buffer.from(objects.get(mine) as Buffer)
    bytes[bytes.length - 1] ^= 0xff
    objects.set(mine, bytes)

    await assert.rejects(() => getVaultPayload("u1", "github", "work", store))
  })

  /**
   * keeps every key under the prefix the purge sweeps
   */
  it("keeps every key under the prefix the purge sweeps", async () => {
    const {store, objects} = memoryStore()
    await putVaultPayload("u1", "github", "work", {jar: "x"}, store)
    await dropVaultPayload("u1", "github", "work", store)

    assert.equal(objects.size, 0, "drop must delete the derived key")
    assert.ok(
      vaultBlobKey("u1", "github", "work").startsWith(vaultKeyPrefix("u1")),
    )
  })

  /**
   * refuses to seal without a key
   */
  it("refuses to seal without a key", async () => {
    setKey("")
    try {
      const {store, objects} = memoryStore()

      assert.equal(vaultStorageAvailable(), false)
      await assert.rejects(
        () => putVaultPayload("u1", "github", "work", {jar: "x"}, store),
        "an unconfigured deployment must refuse, not write plaintext",
      )
      assert.equal(objects.size, 0, "and it must not have written anything")
    } finally {
      setKey(MASTER)
    }
  })
})
