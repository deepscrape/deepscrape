/* eslint-disable max-len */
/**
 * The vault route's request rules.
 *
 * Pure, so every branch is testable without a bucket, a key or a request -- which
 * matters because the branches that matter here are the ones that decide what
 * gets WRITTEN: a name that becomes an object key, and a payload that has to fit
 * the limit at the point the caller can still be told.
 */
import {describe, it} from "node:test"
import assert from "node:assert/strict"
import {
  VAULT_PAYLOAD_MAX_BYTES,
} from "../domain/vault-payload.domain"
import {vaultRequestFrom} from "./vault"

/** The parsed request for one body, so a case can be one line.
 * @param {unknown} body The request body.
 * @return {object} The parsed request.
 */
const parse = (body: unknown) => vaultRequestFrom(body)

/**
 * vault request parsing
 */
describe("vaultRequestFrom", () => {
  /**
   * accepts a store with both names and a payload
   */
  it("accepts a store with both names and a payload", () => {
    const parsed = parse({
      op: "store",
      service: "github",
      profile: "work",
      payload: {cookies: [{name: "sid", value: "x"}]},
    })

    assert.equal(parsed.ok, true)
    assert.equal(parsed.ok ? parsed.op : undefined, "store")
  })

  /**
   * normalises the op rather than refusing it
   */
  it("normalises the op rather than refusing it", () => {
    // A client sending `Store` is asking for the same thing; the op is an
    // enumerated name, not free text.
    const parsed = parse({op: "  LIST "})

    assert.equal(parsed.ok, true)
    assert.equal(parsed.ok ? parsed.op : undefined, "list")
  })

  /**
   * refuses an op it does not implement, naming the ones it does
   */
  it("refuses an op it does not implement, naming the ones it does", () => {
    const parsed = parse({op: "restore"})

    assert.equal(parsed.ok, false)
    assert.equal(parsed.ok ? 0 : parsed.status, 400)
    assert.match(parsed.ok ? "" : parsed.error, /store, load, list, forget/)
  })

  /**
   * refuses a name that would climb out of the vault's namespace
   */
  it("refuses a name that would climb out of the vault's namespace", () => {
    // These reach an OBJECT KEY (`vault/<uid>/<service>/<profile>.json`) as well
    // as a document id, so the guard is stricter than Firestore's own.
    for (const service of ["..", "a/b", "a\\b", "", ".hidden", "-flag", "a".repeat(65)]) {
      const parsed = parse({op: "store", service, profile: "work", payload: {}})
      assert.equal(parsed.ok, false, `service=${service}`)
    }
    for (const profile of [undefined, null, 7, {}, ["x"]]) {
      const parsed = parse({op: "store", service: "github", profile, payload: {}})
      assert.equal(parsed.ok, false, `profile=${String(profile)}`)
    }
  })

  /**
   * refuses a store with no payload
   */
  it("refuses a store with no payload", () => {
    for (const payload of [undefined, null]) {
      const parsed = parse({op: "store", service: "github", profile: "work", payload})
      assert.equal(parsed.ok, false, String(payload))
      assert.match(parsed.ok ? "" : parsed.error, /needs a payload/)
    }

    // `false` and `0` are VALUES, not absences: a caller storing a flag is not
    // making a mistake, and treating them as missing is how a restore writes
    // nothing.
    for (const payload of [false, 0, ""]) {
      const parsed = parse({op: "store", service: "github", profile: "work", payload})
      assert.equal(parsed.ok, true, String(payload))
    }
  })

  /**
   * refuses a payload over the limit, and says how big it was
   */
  it("refuses a payload over the limit, and says how big it was", () => {
    const parsed = parse({
      op: "store",
      service: "github",
      profile: "work",
      payload: {jar: "x".repeat(VAULT_PAYLOAD_MAX_BYTES)},
    })

    assert.equal(parsed.ok, false)
    assert.equal(parsed.ok ? 0 : parsed.status, 400)
    assert.match(parsed.ok ? "" : parsed.error, /over the \d+-byte limit/)
  })

  /**
   * does not need the names for a list
   */
  it("does not need the names for a list", () => {
    const parsed = parse({op: "list"})

    assert.equal(parsed.ok, true)
    assert.equal(parsed.ok ? parsed.op : undefined, "list")
  })

  /**
   * needs the names for a load and a forget
   */
  it("needs the names for a load and a forget", () => {
    for (const op of ["load", "forget"]) {
      assert.equal(parse({op}).ok, false, op)
      assert.equal(parse({op, service: "github", profile: "work"}).ok, true, op)
    }
  })
})
