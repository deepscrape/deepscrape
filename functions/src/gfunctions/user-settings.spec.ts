/* eslint-disable max-len */
/**
 * The regressions the BYOK-to-Secret-Manager move could silently re-open.
 *
 * Asserts the shape of the source rather than behaviour, for the same reason
 * `handlers/ai-keys.spec.ts` does: importing `gfunctions/user-settings.ts`
 * executes `app/config.ts`, which constructs the Firebase Admin app and a
 * Secret Manager client at module load, so a behavioural test would need a live
 * emulator merely to import the module.
 *
 * Both failures guarded here are silent:
 *
 *  1. Writing the key back into a Firestore field. Everything keeps working;
 *     the credential simply sits in a document again, where a rules mistake or
 *     a backup export exposes it. Nothing else in the suite would notice.
 *  2. Migrating a legacy key without destroying the plaintext copy, or purging
 *     the secret after the metadata that points at it, either of which leaks
 *     the old value or orphans a working key.
 */
import {describe, it} from "node:test"
import assert from "node:assert/strict"
import {readFileSync} from "node:fs"

// Relative to the package root, matching ai-keys.spec.ts: the functions
// tsconfig's module setting rejects `import.meta.url` (TS1343).
const settings = readFileSync("src/gfunctions/user-settings.ts", "utf8")
const config = readFileSync("src/app/config.ts", "utf8")

describe("a BYOK value is never stored in Firestore", () => {
  it("writes no bare value beside the vendor id", () => {
    // The legacy shape was `.set({ [vendor]: key.trim() }, { merge: true })`.
    // A bare string written at that key IS the regression.
    const plaintext = [...settings.matchAll(/\[vendor\]:\s*(?:key|value)\b/g)]
    assert.equal(
      plaintext.length,
      0,
      "a Firestore write stores the key itself; it must store only metadata"
    )
  })

  it("still routes the value through upsertSecretValue", () => {
    // Not vacuous: the check above would also pass if the write were deleted
    // outright, which would mean BYOK quietly stopped persisting anything.
    assert.match(settings, /upsertSecretValue\(\s*aiKeySecretId\(uid, vendor\)/)
  })

  it("records the secret path and an updatedAt as metadata", () => {
    assert.match(settings, /secretPath,\s*updatedAt/)
  })
})

describe("clearMyAiKey destroys the value before forgetting where it was", () => {
  it("purges every version of the secret", () => {
    assert.match(settings, /purgeSecretAndAllRevisions\(secretPath\)/)
  })

  it("purges before deleting the metadata that points at it", () => {
    const purge = settings.indexOf("purgeSecretAndAllRevisions(secretPath)")
    const fieldDelete = settings.indexOf("FieldValue.delete()")
    assert.ok(purge > 0 && fieldDelete > 0, "expected both a purge and a field delete")
    assert.ok(
      purge < fieldDelete,
      "the metadata delete precedes the purge, so a failed purge would leave the secret unreachable and still readable by anyone with secret access"
    )
  })
})

describe("a legacy plaintext key keeps working", () => {
  it("branches on the value's type, the only discriminator between the two layouts", () => {
    assert.match(settings, /typeof entry === "string"/)
  })

  it("returns the legacy value rather than falling through to null", () => {
    assert.match(
      settings,
      /migrateLegacyKey\(uid, vendor, entry\)\s*\n\s*return entry/
    )
  })

  it("writes the secret before it overwrites the plaintext field", () => {
    // This ordering is what makes the migration fail safe: a Secret Manager
    // outage must degrade to "still reads the old field", never to a lost key.
    const secretWrite = settings.indexOf("await upsertSecretValue(")
    const metadataWrite = settings.indexOf(
      "{ [vendor]: { secretPath, updatedAt: Date.now() } }"
    )
    assert.ok(secretWrite > 0 && metadataWrite > 0, "expected both writes")
    assert.ok(secretWrite < metadataWrite, "metadata is written before the secret")
  })
})

describe("upsertSecretValue is idempotent so rotation works", () => {
  it("adds a version before it attempts to create the secret", () => {
    // Anchored on the DECLARATION, not on the first mention of the name: the
    // function's own JSDoc names `createSecret` to explain why it is avoided,
    // and a search from the first mention would measure that prose instead of
    // the body. Learned by watching this assertion fail against correct code.
    const from = config.indexOf("export async function upsertSecretValue")
    assert.ok(from > 0, "upsertSecretValue is missing from config.ts")
    const add = config.indexOf("addSecretVersion", from)
    const create = config.indexOf("createSecret", from)
    assert.ok(add > 0 && create > 0, "expected both addSecretVersion and createSecret")
    assert.ok(
      add < create,
      "createSecret runs first, so saving the same key twice would fail with ALREADY_EXISTS"
    )
  })

  it("creates only when the secret is absent", () => {
    assert.match(config, /SECRET_NOT_FOUND/)
  })
})
