/* eslint-disable max-len */
/**
 * The vault payload's sealing rules.
 *
 * Every case here is a decision that is invisible in a handler and only shows up
 * as a credential leak or an unreadable profile: that a nonce is never reused,
 * that a tampered byte is refused rather than returned, that another account's
 * key cannot open this account's blob, and that an envelope from a future build
 * fails closed instead of being guessed at.
 */
import {describe, it} from "node:test"
import assert from "node:assert/strict"
import {
  VAULT_PAYLOAD_ENVELOPE_VERSION,
  VAULT_PAYLOAD_MAX_BYTES,
  derivedVaultKey,
  openVaultPayload,
  sealVaultPayload,
} from "./vault-payload.domain"

// Synthetic, and obviously so: 32 bytes of the same value. A realistic-looking
// key in a repo is a key someone eventually deploys.
const MASTER = Buffer.alloc(32, 7).toString("base64")
const OTHER_MASTER = Buffer.alloc(32, 9).toString("base64")

/** The envelope a write produced, as the store would hand it back.
 * @param {object} overrides Fields to replace on a well-formed envelope.
 * @return {Buffer} The envelope bytes.
 */
const envelopeWith = (overrides: Record<string, unknown> = {}): Buffer =>
  Buffer.from(JSON.stringify({
    v: VAULT_PAYLOAD_ENVELOPE_VERSION,
    iv: Buffer.alloc(12, 1).toString("base64"),
    tag: Buffer.alloc(16, 2).toString("base64"),
    data: Buffer.from("not really ciphertext").toString("base64"),
    ...overrides,
  }), "utf8")

/**
 * vault-payload.domain
 */
describe("vault payload sealing", () => {
  /**
   * round-trips a payload
   */
  it("round-trips a payload", () => {
    const key = derivedVaultKey(MASTER, "u1")
    const payload = JSON.stringify({cookies: [{name: "sid"}]})
    const sealed = sealVaultPayload(key, payload)

    assert.equal(openVaultPayload(key, sealed), payload)
  })

  /**
   * never writes the plaintext into the envelope
   */
  it("never writes the plaintext into the envelope", () => {
    const key = derivedVaultKey(MASTER, "u1")
    const sealed = sealVaultPayload(key, "session-token-value").toString("utf8")

    assert.equal(sealed.includes("session-token-value"), false)
  })

  /**
   * uses a fresh nonce per write, and reads both back
   */
  it("uses a fresh nonce per write, and reads both back", () => {
    // A reused nonce is the one way GCM actually breaks, and a counter would
    // have to be stored to be safe -- so randomness is asserted rather than
    // assumed.
    const key = derivedVaultKey(MASTER, "u1")
    const first = sealVaultPayload(key, "same")
    const second = sealVaultPayload(key, "same")

    assert.notDeepEqual(first, second, "the same plaintext must not seal twice alike")
    assert.equal(openVaultPayload(key, first), "same")
    assert.equal(openVaultPayload(key, second), "same")
  })

  /**
   * refuses a tampered envelope instead of answering with plaintext
   */
  it("refuses a tampered envelope instead of answering with plaintext", () => {
    const key = derivedVaultKey(MASTER, "u1")
    const sealed = JSON.parse(sealVaultPayload(key, "jar").toString("utf8"))
    const bytes = Buffer.from(sealed.data, "base64")
    bytes[0] ^= 0xff
    const tampered = Buffer.from(JSON.stringify({
      ...sealed,
      data: bytes.toString("base64"),
    }), "utf8")

    assert.throws(() => openVaultPayload(key, tampered))
  })

  /**
   * refuses another account's key, and another master
   */
  it("refuses another account's key, and another master", () => {
    const sealed = sealVaultPayload(derivedVaultKey(MASTER, "u1"), "jar")

    assert.throws(
      () => openVaultPayload(derivedVaultKey(MASTER, "u2"), sealed),
      "another account's derived key must not open this payload",
    )
    assert.throws(
      () => openVaultPayload(derivedVaultKey(OTHER_MASTER, "u1"), sealed),
      "a rotated master must fail loudly, not read garbage",
    )
  })

  /**
   * fails closed on an envelope it cannot account for
   */
  it("fails closed on an envelope it cannot account for", () => {
    const key = derivedVaultKey(MASTER, "u1")

    // A version this build does not know. Refused rather than guessed at: the
    // only other option is reading bytes whose meaning a later build decided.
    assert.throws(() => openVaultPayload(key, envelopeWith({v: 2})))
    assert.throws(() => openVaultPayload(key, envelopeWith({v: undefined})))
    assert.throws(() => openVaultPayload(key, envelopeWith({iv: ""})))
    assert.throws(() => openVaultPayload(key, envelopeWith({tag: null})))
    assert.throws(() => openVaultPayload(key, Buffer.from("not json", "utf8")))
  })

  /**
   * ignores an unknown field, so a newer writer is not fatal
   */
  it("ignores an unknown field, so a newer writer is not fatal", () => {
    // The forward-compatibility half of the durable-shape rule. It must not
    // reach the decipher only for a build that adds metadata to the envelope.
    const key = derivedVaultKey(MASTER, "u1")
    const sealed = sealVaultPayload(key, "jar")
    const doc = JSON.parse(sealed.toString("utf8")) as Record<string, unknown>
    const withExtra = Buffer.from(JSON.stringify({...doc, kid: "future"}), "utf8")

    assert.equal(openVaultPayload(key, withExtra), "jar")
  })

  /**
   * refuses a payload over the size limit
   */
  it("refuses a payload over the size limit", () => {
    const key = derivedVaultKey(MASTER, "u1")

    assert.throws(
      () => sealVaultPayload(key, "x".repeat(VAULT_PAYLOAD_MAX_BYTES + 1)),
      "the limit is on plaintext bytes, before anything is written",
    )
    assert.doesNotThrow(() => sealVaultPayload(key, "x".repeat(VAULT_PAYLOAD_MAX_BYTES)))
  })

  /**
   * refuses a master key that is not 32 bytes
   */
  it("refuses a master key that is not 32 bytes", () => {
    // A 16-byte value pasted into a 32-byte setting is a configuration mistake,
    // and deriving from it anyway would hide the mistake until an audit.
    assert.throws(() => derivedVaultKey("", "u1"))
    assert.throws(() => derivedVaultKey(Buffer.alloc(16, 1).toString("base64"), "u1"))
    assert.doesNotThrow(() => derivedVaultKey(MASTER, "u1"))
  })
})
