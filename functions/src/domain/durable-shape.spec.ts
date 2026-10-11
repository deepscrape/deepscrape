/* eslint-disable max-len */
/**
 * The durable-shape contract: how a stored document may change without a version.
 *
 * Two rules, and this file is where they are held:
 *   1. A parser validates every field it hands back and drops the row otherwise
 *      -- never a cast, never a half-built record.
 *   2. Unknown FIELDS are ignored, unknown ENUM VALUES fail closed. That pair is
 *      what makes a version field unnecessary: an older build reading a newer
 *      document keeps the fields it knows and refuses a value it cannot act on.
 *      A `v` field could only tell those two cases apart in order to do exactly
 *      this, at the cost of a second thing to keep in step.
 *
 * `monitor.store.ts` is the one store that still casts its documents. Its two
 * dangerous fields are clamped before use -- `clampIntervalMinutes`, and a parked
 * `nextCheckAt` for a disabled monitor -- so the cast is a display concern today.
 * Give it a parser when either of those stops being true.
 *
 * See docs/ADR-2026-10-DURABLE-SHAPE-DISCIPLINE.md.
 */
import {describe, it} from "node:test"
import assert from "node:assert/strict"
import {parseCachedJson} from "../app/cacheConfig"
import {parseSession} from "../infrastructure/browser-session.store"

/** A stored session document, with fields under test overridden.
 * @param {Record<string, unknown>} overrides The fields to override.
 * @return {Record<string, unknown>} A complete stored session.
 */
const storedSession = (
  overrides: Record<string, unknown> = {}
): Record<string, unknown> => ({
  createdAt: 1_000,
  lastUsedAt: 2_000,
  state: "ready",
  tier: "free",
  kind: "chrome",
  mode: "dedicated",
  ...overrides,
})

/**
 * durable shapes
 */
describe("durable shapes", () => {
  /**
   * reads a complete document
   */
  it("reads a complete document", () => {
    const record = parseSession("s1", storedSession())

    assert.equal(record?.id, "s1")
    assert.equal(record?.state, "ready")
    assert.equal(record?.minutesBilled, 0, "an absent counter reads as zero, not undefined")
  })

  /**
   * ignores a field it has never heard of
   */
  it("ignores a field it has never heard of", () => {
    // A newer build writing `framesSent` mid-deploy must not make this build drop
    // the session: that is the forward-compatibility rule, and the whole reason a
    // shape does not need a version number.
    const record = parseSession("s1", storedSession({framesSent: 12, machineId: "m1"}))

    assert.equal(record?.id, "s1")
    assert.equal(record?.machineId, "m1", "a known field beside it still reads")
  })

  /**
   * fails closed on a value it cannot act on
   */
  it("fails closed on a value it cannot act on", () => {
    // The inverse of the rule above: a value this build has no branch for is not
    // one it may carry forward. Adding one is a two-phase rollout -- readers
    // first, then writers -- which is the procedure, not a version number.
    assert.equal(parseSession("s1", storedSession({state: "hibernating"})), undefined)
    assert.equal(parseSession("s1", storedSession({tier: "trial"})), undefined)
    assert.equal(parseSession("s1", storedSession({kind: "firefox"})), undefined)
    assert.equal(parseSession("s1", storedSession({mode: "shared"})), undefined)
  })

  /**
   * drops the row rather than returning a partial record
   */
  it("drops the row rather than returning a partial record", () => {
    assert.equal(parseSession("s1", storedSession({createdAt: undefined})), undefined)
    assert.equal(parseSession("s1", storedSession({createdAt: "1000"})), undefined)
    assert.equal(parseSession("s1", storedSession({lastUsedAt: Number.NaN})), undefined)
  })

  /**
   * never throws on a cache read
   */
  it("never throws on a cache read", () => {
    // Six call sites treat null as a miss and refetch from the source of truth. A
    // throw would surface as a failed request instead, which is how the session,
    // revocation, device-trust and geo caches were silently disabled before.
    assert.equal(parseCachedJson("{not json"), null)
    assert.equal(parseCachedJson(undefined), null)
    assert.equal(parseCachedJson(null), null)
    assert.equal(parseCachedJson(0), 0, "a falsy-but-valid value is a value, not a miss")
  })

  /**
   * normalizes both shapes the client can return
   */
  it("normalizes both shapes the client can return", () => {
    // Upstash's REST client auto-deserializes, so an object is the common case and
    // a string is the odd one. Every `typeof === "string"` guard missed the first.
    const serialized = JSON.stringify({a: 1})
    assert.deepEqual(parseCachedJson(serialized), {a: 1})
    assert.deepEqual(parseCachedJson({a: 1}), {a: 1})
    assert.equal(parseCachedJson("42"), 42)
  })
})
