/* eslint-disable max-len */
/**
 * One counter, two caps — the bug was that the counter ignored which cap it was for.
 *
 * `decideLease` compares `liveSessions` against `caps.byo` (3) on the BYO branch and
 * `caps.dedicated` (1) below it. While the count covered every mode, three free BYO
 * sessions satisfied `3 < 3` and a customer with a PAID tier was told `quota` for the
 * dedicated machine they were paying for. Nothing logged it as an error: `quota` is a
 * legitimate answer, just to a different question.
 *
 * `countLive` takes a Firestore snapshot, but only reads `docs[].id` and
 * `data()` — so a plain object is enough to exercise the real filter rather than a
 * re-implementation of it.
 */
import {describe, it} from "node:test"
import assert from "node:assert/strict"
import {countLive} from "../infrastructure/browser-session.store"
import {decideLease} from "../domain/browser-session.domain"

// A stored session carrying every field `parseSession` validates.
//
// Both literals matter: `kind` must be one of BROWSER_KINDS (chrome | lightpanda |
// obscura) and `state` one of SESSION_STATES (starting | ready | suspended |
// closed). Getting either wrong makes `parseSession` return undefined, the document
// disappears from the count, and the assertions below pass as "0 live sessions"
// instead of testing anything. "running" is not a state here; it maps to `ready`.
const session = (id: string, mode: string, state: string) => ({
  id,
  data: () => ({
    mode,
    kind: "chrome",
    state: state === "running" ? "ready" : state,
    tier: "paid",
    createdAt: 1,
    lastUsedAt: 1,
    minutesBilled: 0,
  }),
})

const snapshotOf = (...docs: unknown[]) => ({docs} as never)

describe("live session counting", () => {
  it("counts only the requested mode", () => {
    const snapshot = snapshotOf(
      session("a", "byo", "running"),
      session("b", "byo", "starting"),
      session("c", "dedicated", "running"),
    )

    assert.equal(countLive(snapshot, "byo"), 2)
    assert.equal(countLive(snapshot, "dedicated"), 1)
  })

  it("excludes closed sessions from both modes", () => {
    const snapshot = snapshotOf(
      session("a", "byo", "closed"),
      session("b", "dedicated", "closed"),
    )

    assert.equal(countLive(snapshot, "byo"), 0)
    assert.equal(countLive(snapshot, "dedicated"), 0)
  })

  it("does not spend a paid dedicated slot on free BYO sessions", () => {
    const threeByoSessions = snapshotOf(
      session("a", "byo", "running"),
      session("b", "byo", "running"),
      session("c", "byo", "running"),
    )

    // The paid tier offers one dedicated machine; the caller holds none.
    const decision = decideLease({
      tier: "paid",
      mode: "dedicated",
      kind: "chrome",
      liveSessions: countLive(threeByoSessions, "dedicated"),
      byoConfigured: false,
    })

    assert.deepEqual(decision, {ok: true})
  })

  it("still refuses a fourth BYO session on the paid tier", () => {
    const threeByoSessions = snapshotOf(
      session("a", "byo", "running"),
      session("b", "byo", "running"),
      session("c", "byo", "running"),
    )

    const decision = decideLease({
      tier: "paid",
      mode: "byo",
      kind: "chrome",
      liveSessions: countLive(threeByoSessions, "byo"),
      byoConfigured: true,
    })

    assert.deepEqual(decision, {ok: false, reason: "quota"})
  })
})
