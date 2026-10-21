/* eslint-disable max-len */
/* eslint-disable object-curly-spacing */
/**
 * The two properties a passing request would not reveal.
 *
 *  1. The scope is decided BEFORE a store is resolved. A handler that resolved
 *     the store first could be edited into picking the shared bucket for a
 *     credentialed fetch, and every behavioural test would still pass because
 *     the shared tier is a legitimate outcome for an anonymous one.
 *  2. A BYOB credential cannot reach a client. It is a third-party secret, and
 *     the failure mode -- echoing it back in a settings response -- is silent.
 *
 * Read as source rather than imported: this module pulls in `app/config`, which
 * builds the Admin SDK and a Secret Manager client at load, so a behavioural
 * test would need a live emulator merely to import it.
 * `gfunctions/user-settings.spec.ts` takes the same route for the same reason.
 */
import {describe, it} from "node:test"
import assert from "node:assert/strict"
import {readFileSync} from "node:fs"

// Relative to the package root, matching the other source-shape specs: the
// functions tsconfig's module setting rejects `import.meta.url` (TS1343).
const handlers = readFileSync("src/handlers/storage.ts", "utf8")
const store = readFileSync("src/infrastructure/storage-settings.store.ts", "utf8")
const scope = readFileSync("src/domain/storage-scope.domain.ts", "utf8")
const settings = readFileSync("src/domain/storage-settings.domain.ts", "utf8")

describe("the scope is decided before any store is touched", () => {
  it("calls decideStorageScope ahead of resolveBlobStore on the save path", () => {
    const decided = handlers.indexOf("decideStorageScope(uid, url, body")
    const resolved = handlers.indexOf(
      "await resolveBlobStore(uid, decision.scope)"
    )

    assert.ok(decided > 0, "the save route no longer decides a scope")
    assert.ok(
      resolved > decided,
      "the store is resolved before the scope is decided"
    )
  })

  it("cannot mint a shared key outside the domain", () => {
    // If the handler could compose one itself there would be two answers to
    // "may this be shared?", which is the whole defect this design removes.
    assert.equal(/sharedObjectKey\(/.test(handlers), false)
    assert.match(scope, /export const sharedObjectKey/)
  })
})

describe("a BYOB credential cannot reach a client", () => {
  it("names neither credential field anywhere in the request handler", () => {
    // The handler is where a response is composed, so a credential name here
    // would mean a credential on a wire. This assertion used to scan the STORE
    // as well, and stopped measuring the right thing the moment BYOB became
    // real: the store now names these fields once, to hand them to the signer.
    // "Mentions the word" is not "can reach a client", and the two diverged.
    assert.equal(
      /accessKey|secretKey/.test(handlers),
      false,
      "a credential field name appears in the request handler"
    )
  })

  it("keeps the credential out of the read path the GET route uses", () => {
    // The precise replacement for that over-broad scan: the function answering
    // `GET /api/storage/settings` must not be able to see a secret at all.
    const readStart = store.indexOf("export const readStorageSettings")
    const readEnd = store.indexOf("const hasSecretPointer")

    assert.ok(
      readStart > 0 && readEnd > readStart,
      "readStorageSettings moved or was renamed"
    )

    assert.equal(
      /accessKey|secretKey/.test(store.slice(readStart, readEnd)),
      false,
      "the settings read path can see a credential"
    )
  })

  it("gives the public projection no field a credential could occupy", () => {
    assert.match(
      settings,
      /export type StorageSettingsPublic = \{\s*mode: StorageMode\s*hasCredentials: boolean\s*bucket\?: string\s*\}/
    )
  })

  it("routes the value through Secret Manager and keeps only the pointer", () => {
    assert.match(store, /upsertSecretValue\(\s*byobSecretId\(uid\)/)
    assert.match(store, /secretPath,/)
    // Not `saveToSecretManager`: that create-only call answers ALREADY_EXISTS
    // on a second save, so a caller could never rotate their key.
    assert.equal(store.includes("saveToSecretManager"), false)
  })

  it("answers the public projection, never the stored document", () => {
    assert.match(store, /return toPublicSettings\(/)
    assert.match(handlers, /toPublicSettings\(settings\)/)
  })
})

describe("the shared tier is not a fallback", () => {
  it("gives the user tier when no descriptor was sent", () => {
    assert.match(scope, /"no-descriptor"/)
    assert.match(
      scope,
      /scope: "user",\s*key: userObjectKey\(uid, url\)/
    )
  })

  it("refuses the shared tier for credential material", () => {
    assert.match(scope, /reason: "credentialed"/)
  })
})

describe("an incomplete BYOB target is never silently redirected", () => {
  it("cannot fall back to the platform bucket after choosing BYOB", () => {
    // The dangerous shape: a BYOB caller with a half-written configuration
    // quietly getting OUR bucket, because the code's last resort is the
    // platform store. Checked by position -- nothing AFTER the BYOB branch may
    // reach for the platform store. Before it, both shared and platform-mode
    // callers legitimately do.
    const byobBranch = store.indexOf("const config = await byobConfigFor(uid)")

    assert.ok(byobBranch > 0, "the BYOB branch is no longer resolvable")

    const tail = store.slice(byobBranch)

    assert.equal(
      tail.includes("getPlatformBlobStore"),
      false,
      "the BYOB branch can fall back to the platform bucket"
    )
    assert.match(tail, /getByobBlobStore\(config\)/)
  })

  it("refuses a target missing a bucket, an endpoint or a secret", () => {
    const byobStart = store.indexOf("const byobConfigFor")
    const byobEnd = store.indexOf("export const resolveBlobStore")

    assert.ok(
      byobStart > 0 && byobEnd > byobStart,
      "byobConfigFor moved or was renamed"
    )

    const byob = store.slice(byobStart, byobEnd)

    assert.match(byob, /data\.mode !== "byob"/, "the mode is not re-checked")
    assert.match(
      byob,
      /if \(bucket\.length === 0 \|\| endpoint\.length === 0\)/,
      "a blank bucket or endpoint would be signed against"
    )
    assert.match(byob, /if \(!credentials\)/, "a missing secret is not refused")
  })
})

describe("switching to the platform bucket actually removes the credential", () => {
  it("reads the pointer before the write that erases it", () => {
    const writeStart = store.indexOf("export const writeStorageSettings")
    const writeEnd = store.indexOf("export const readUserByobCredentials")

    assert.ok(
      writeStart > 0 && writeEnd > writeStart,
      "writeStorageSettings moved or was renamed"
    )

    const write = store.slice(writeStart, writeEnd)

    // The whole trick is the ordering. After the `set` clears `secretPath`
    // nothing records which secret to destroy, so reading it afterwards would
    // silently fail to purge and leave the key in Secret Manager forever.
    const readPath = write.indexOf("priorPath")
    // The platform branch's `set` IS the erasure. Located by the call rather
    // than by the field name, so this assertion needs no nested quoting.
    const erasure = write.indexOf("settingsRef(uid).set(")

    assert.ok(readPath > 0, "the platform branch no longer reads the prior path")
    assert.ok(
      erasure > readPath,
      "the secret path is read after the write that erases it"
    )
  })

  it("deletes the pointer and purges every version", () => {
    const write = store.slice(
      store.indexOf("export const writeStorageSettings"),
      store.indexOf("export const readUserByobCredentials")
    )

    assert.match(write, /secretPath: FieldValue\.delete\(\)/)
    assert.match(write, /purgeSecretAndAllRevisions\(priorPath\)/)
  })
})

describe("the listing cannot hand out another tenant's capability URL", () => {
  it("filters the shared tier through the exposure predicate", () => {
    const listStart = handlers.indexOf("export const storageList")
    const listEnd = handlers.indexOf("export const storagePresign")

    assert.ok(
      listStart > 0 && listEnd > listStart,
      "storageList moved or was renamed"
    )

    const list = handlers.slice(listStart, listEnd)

    assert.match(list, /isExposableSharedUrl\(/)

    // The filter has to run BEFORE the response is composed, or the unfiltered
    // array is what the caller receives.
    assert.ok(
      list.indexOf("isExposableSharedUrl") < list.indexOf("objects:"),
      "the shared tier is listed before it is filtered"
    )

    // The user tier is still listed in full: those entries are the caller's.
    assert.match(list, /\[\.\.\.own, \.\.\.visible\]/)
  })
})
